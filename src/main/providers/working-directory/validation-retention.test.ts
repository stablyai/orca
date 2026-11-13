import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { stat } = vi.hoisted(() => ({
  stat: vi.fn<() => Promise<{ isDirectory: () => boolean }>>()
}))
vi.mock('node:fs/promises', () => ({ stat }))
vi.mock('../../wsl/filesystem/unc-path-access', () => ({
  wslUncDirectoryExistsAsync: () => {
    throw new Error('Unexpected WSL probe')
  }
}))

import {
  _resetWorkingDirectoryValidationStateForTest,
  validateWorkingDirectoryAsync as validate,
  WorkingDirectoryValidationAbortedError
} from './validation'

const directory = { isDirectory: () => true }
const cwd = 'synthetic-cwd-wait-retention'

function pendingStat() {
  const gate = Promise.withResolvers<typeof directory>()
  stat.mockReturnValue(gate.promise)
  return gate
}

async function canceledWait(path = cwd) {
  const controller = new AbortController()
  const signal = new WeakRef(controller.signal)
  const waiting = validate(path, { signal: controller.signal })
  controller.abort()
  try {
    await waiting
    throw new Error('Expected cancellation')
  } catch (error) {
    if (!(error instanceof WorkingDirectoryValidationAbortedError)) {
      throw error
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    return { signal, error: new WeakRef(error) }
  }
}

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 6; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

beforeEach(() => {
  stat.mockReset()
  _resetWorkingDirectoryValidationStateForTest()
})
afterEach(() => vi.restoreAllMocks())

describe('working directory validation waiter lifetime', () => {
  it('releases the first caller and subsequent canceled callers while their native stat stays owned', async () => {
    const gate = pendingStat()
    try {
      const first = await canceledWait()
      const later: Awaited<ReturnType<typeof canceledWait>>[] = []
      for (let index = 0; index < 31; index += 1) {
        later.push(await canceledWait())
      }
      await collect()
      expect(first.signal.deref()).toBeUndefined()
      expect(first.error.deref()).toBeUndefined()
      expect(later.filter((ref) => ref.signal.deref() || ref.error.deref())).toHaveLength(0)
      expect(stat).toHaveBeenCalledOnce()

      const staying = validate(cwd)
      expect(stat).toHaveBeenCalledOnce()
      gate.resolve(directory)
      await staying
    } finally {
      gate.resolve(directory)
    }
  })

  it('preserves the raw operation when the first caller is already aborted', async () => {
    const gate = pendingStat()
    try {
      const signal = AbortSignal.abort()
      await expect(validate(cwd, { signal })).rejects.toBeInstanceOf(
        WorkingDirectoryValidationAbortedError
      )
      const first = validate(cwd)
      expect(validate(cwd)).toBe(first)
      expect(stat).toHaveBeenCalledOnce()
      expect(getEventListeners(signal, 'abort')).toHaveLength(0)
      gate.resolve(directory)
      await first
    } finally {
      gate.resolve(directory)
    }
  })

  it('handles native rejection after every caller has already canceled', async () => {
    const unhandled: unknown[] = []
    const recordUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', recordUnhandled)
    const gate = pendingStat()
    try {
      await canceledWait()
      gate.reject(new Error('Late native failure'))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
      stat.mockResolvedValue(directory)
      await validate(cwd)
      expect(stat).toHaveBeenCalledTimes(2)
    } finally {
      gate.resolve(directory)
      process.off('unhandledRejection', recordUnhandled)
    }
  })

  it.each(
    (['before', 'between', 'after'] as const).flatMap((position) =>
      [false, true].map((reject) => ({ position, reject }))
    )
  )(
    'preserves an external raw observer at $position with reject=$reject',
    async ({ position, reject }) => {
      const gate = pendingStat()
      const raw = validate(cwd)
      const controller = new AbortController()
      const start = () =>
        validate(cwd, { signal: controller.signal }).then(
          () => 'fulfilled',
          (error: unknown) => (error instanceof Error ? error.name : 'unknown')
        )
      const waiters: Promise<string>[] = []
      if (position !== 'before') {
        waiters.push(start())
      }
      const abortObserver = raw.then(
        () => controller.abort(),
        () => controller.abort()
      )
      if (position !== 'after') {
        waiters.push(start())
      }
      if (reject) {
        gate.reject(new Error('Native stat failed'))
      } else {
        gate.resolve(directory)
      }
      const rawOutcome = reject ? 'Error' : 'fulfilled'
      expect(await Promise.all(waiters)).toEqual(
        position === 'before'
          ? ['WorkingDirectoryValidationAbortedError']
          : position === 'between'
            ? [rawOutcome, 'WorkingDirectoryValidationAbortedError']
            : [rawOutcome]
      )
      await abortObserver
    }
  )
})
