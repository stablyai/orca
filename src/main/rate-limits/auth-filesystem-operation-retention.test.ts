import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

function pendingOperation(): {
  operation: SharedAuthFilesystemOperation<string>
  resolve: (value: string) => void
  reject: (reason: unknown) => void
  rawCalls: () => number
} {
  let resolve = (_value: string): void => {}
  let reject = (_reason: unknown): void => {}
  let calls = 0
  const operation = createAuthFilesystemOperation('auth-retention-fixture', () => {
    calls += 1
    return new Promise<string>((resolveRaw, rejectRaw) => {
      resolve = resolveRaw
      reject = rejectRaw
    })
  })
  return {
    operation,
    resolve: (value) => resolve(value),
    reject: (reason) => reject(reason),
    rawCalls: () => calls
  }
}

async function abortWait(
  operation: SharedAuthFilesystemOperation<string>
): Promise<WeakRef<Error>> {
  const controller = new AbortController()
  const reason = new Error('Auth poll expired')
  const weakReason = new WeakRef(reason)
  const result = operation.wait(controller.signal)
  controller.abort(reason)
  await result.catch((error: unknown) => {
    if (error !== reason) {
      throw new Error('Abort reason identity changed')
    }
  })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  return weakReason
}

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

describe('shared auth filesystem wait lifetime', () => {
  it.each(
    [true, false].flatMap((startedBefore) =>
      [true, false].flatMap((rejectRaw) =>
        [0, 1].map((ticks) => ({ startedBefore, rejectRaw, ticks }))
      )
    )
  )('preserves raw-result/abort ordering for %j', async ({ startedBefore, rejectRaw, ticks }) => {
    const pending = pendingOperation()
    const controller = new AbortController()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const start = (): Promise<unknown> =>
      pending.operation.wait(controller.signal).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason })
      )
    let waiting = startedBefore ? start() : undefined
    if (rejectRaw) {
      pending.reject('raw failure')
    } else {
      pending.resolve('raw success')
    }
    for (let tick = 0; tick < ticks; tick += 1) {
      await Promise.resolve()
    }
    waiting ??= start()
    controller.abort('caller aborted')
    expect(await waiting).toEqual(
      ticks === 0
        ? { status: 'rejected', reason: 'caller aborted' }
        : rejectRaw
          ? { status: 'rejected', reason: 'raw failure' }
          : { status: 'fulfilled', value: 'raw success' }
    )
    expect(pending.rawCalls()).toBe(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('releases aborted poll reasons while one native operation remains needed', async () => {
    const pending = pendingOperation()
    const anchorController = new AbortController()
    const anchor = pending.operation.wait(anchorController.signal)
    await Promise.resolve()
    const thenSpy = vi.spyOn(pending.operation.result, 'then')
    try {
      const reasons: WeakRef<Error>[] = []
      for (let index = 0; index < 64; index += 1) {
        reasons.push(await abortWait(pending.operation))
      }
      await collect()
      expect(reasons.filter((ref) => ref.deref() !== undefined)).toHaveLength(0)
      expect(pending.rawCalls()).toBe(1)
      // Each native-result reaction would outlive every abandoned poll.
      expect(thenSpy).not.toHaveBeenCalled()
    } finally {
      thenSpy.mockRestore()
      pending.resolve('finished')
      await anchor
    }
    expect(getEventListeners(anchorController.signal, 'abort')).toHaveLength(0)
  })

  it('serves a late and then settled result after all previous polls abort', async () => {
    const pending = pendingOperation()
    await Promise.resolve()
    await abortWait(pending.operation)
    const controller = new AbortController()
    const late = pending.operation.wait(controller.signal)
    pending.resolve('late result')
    await expect(late).resolves.toBe('late result')
    await expect(pending.operation.wait(controller.signal)).resolves.toBe('late result')
    expect(pending.rawCalls()).toBe(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('preserves a live sibling and forwards raw failure identity to later waits', async () => {
    const pending = pendingOperation()
    const controller = new AbortController()
    const live = pending.operation.wait(controller.signal)
    await Promise.resolve()
    await abortWait(pending.operation)
    const reason = new Error('Raw filesystem failure')
    const rejected = expect(live).rejects.toBe(reason)
    pending.reject(reason)
    await rejected
    await expect(pending.operation.wait(controller.signal)).rejects.toBe(reason)
    expect(pending.rawCalls()).toBe(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it.each([false, 0, 'custom abort', { code: 'custom abort' }])(
    'preserves the arbitrary abort reason %j',
    async (reason) => {
      const pending = pendingOperation()
      const controller = new AbortController()
      await Promise.resolve()
      const wait = pending.operation.wait(controller.signal)
      controller.abort(reason)
      try {
        await expect(wait).rejects.toBe(reason)
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      } finally {
        pending.resolve('finished')
        await pending.operation.result
      }
    }
  )
})
