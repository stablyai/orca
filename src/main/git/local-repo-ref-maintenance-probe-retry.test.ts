import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'
import { RepoRefMaintenance } from '../../shared/repo-ref-maintenance'
import {
  REF_MAINTENANCE_ATTEMPT_DEADLINE_MS,
  REF_MAINTENANCE_CLEAN_COOLDOWN_MS
} from '../../shared/repo-ref-maintenance-policy'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
vi.mock('./runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { createLocalRepoRefMaintenanceTarget } from './local-repo-ref-maintenance'

const QUIET_MS = 1000
const engines: RepoRefMaintenance[] = []

function createHarness() {
  const spans: Record<string, unknown>[] = []
  const onError = vi.fn()
  const maintenance = new RepoRefMaintenance({
    quietPeriodMs: QUIET_MS,
    onError,
    observe: (attempt) => {
      const attributes: Record<string, unknown> = {}
      spans.push(attributes)
      return attempt({
        setAttribute: (key, value) => {
          attributes[key] = value
        }
      })
    }
  })
  engines.push(maintenance)
  const maintainPackIndex = vi.fn(async () => {})
  const resolveRefsDirectory = vi.fn(async () => undefined)
  const packRefs = vi.fn(async () => {})
  const target = {
    ...createLocalRepoRefMaintenanceTarget({ key: 'local::/repo/.git', repoPath: '/repo' }),
    maintainPackIndex,
    resolveRefsDirectory,
    packRefs
  }
  return { maintenance, target, spans, onError, maintainPackIndex, resolveRefsDirectory, packRefs }
}

async function elapse(maintenance: RepoRefMaintenance, milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds)
  await maintenance.whenAttemptSettled()
}

beforeEach(() => {
  vi.useFakeTimers()
  gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
})

afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.dispose()
  }
  vi.useRealTimers()
})

describe('local maintenance config probe recovery', () => {
  it('retries a transient config failure before admitting either maintenance phase', async () => {
    const error = new Error('temporary Git spawn failure')
    gitExecFileAsyncMock.mockRejectedValueOnce(error)
    const h = createHarness()
    h.maintenance.arm(h.target)
    await elapse(h.maintenance, QUIET_MS)
    expect(h.spans[0]).toMatchObject({
      'repo.maintenance_outcome': 'failed',
      'repo.maintenance_error': String(error)
    })
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(error)
    expect(h.maintainPackIndex).not.toHaveBeenCalled()
    expect(h.resolveRefsDirectory).not.toHaveBeenCalled()
    expect(h.packRefs).not.toHaveBeenCalled()
    await elapse(h.maintenance, 2 * QUIET_MS - 1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    await elapse(h.maintenance, 1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(h.maintainPackIndex).toHaveBeenCalledTimes(1)
    expect(h.resolveRefsDirectory).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the clean cooldown only for an explicit user opt-out', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'maintenance.auto false\n', stderr: '' })
    const h = createHarness()
    h.maintenance.arm(h.target)
    await elapse(h.maintenance, QUIET_MS)
    expect(h.spans[0]['repo.maintenance_outcome']).toBe('opted_out')
    h.maintenance.arm(h.target)
    await elapse(h.maintenance, REF_MAINTENANCE_CLEAN_COOLDOWN_MS - 1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    await elapse(h.maintenance, 1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(h.onError).not.toHaveBeenCalled()
    expect(h.maintainPackIndex).not.toHaveBeenCalled()
    expect(h.resolveRefsDirectory).not.toHaveBeenCalled()
    expect(h.packRefs).not.toHaveBeenCalled()
  })

  it('caps a persistent config failure at seven probes and six backed-off retries', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('invalid config'))
    const h = createHarness()
    h.maintenance.arm(h.target)
    for (const [index, multiplier] of [1, 2, 4, 8, 8, 8, 8].entries()) {
      await elapse(h.maintenance, QUIET_MS * multiplier - 1)
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(index)
      await elapse(h.maintenance, 1)
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(index + 1)
    }
    await elapse(h.maintenance, REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(7)
    expect(h.onError).toHaveBeenCalledTimes(7)
    expect(h.spans.every((span) => span['repo.maintenance_outcome'] === 'failed')).toBe(true)
    expect(h.maintainPackIndex).not.toHaveBeenCalled()
    expect(h.resolveRefsDirectory).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a newer arm when a stale probe fails', async () => {
    let rejectProbe: (error: Error) => void = () => {}
    gitExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectProbe = reject
        })
    )
    const h = createHarness()
    h.maintenance.arm(h.target)
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    const newIndex = vi.fn(async () => {})
    h.maintenance.arm({ ...h.target, maintainPackIndex: newIndex })
    rejectProbe(new Error('stale failure'))
    await h.maintenance.whenAttemptSettled()
    await elapse(h.maintenance, QUIET_MS)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(newIndex).toHaveBeenCalledOnce()
    expect(h.maintainPackIndex).not.toHaveBeenCalled()
  })

  it.each(['failure', 'opt_out'])('does not re-arm a disposed probe after %s', async (result) => {
    let settle: () => void = () => {}
    gitExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          settle = () =>
            result === 'failure'
              ? reject(new Error('disposed probe'))
              : resolve({ stdout: 'maintenance.auto false\n', stderr: '' })
        })
    )
    const h = createHarness()
    h.maintenance.arm(h.target)
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    h.maintenance.dispose()
    settle()
    await h.maintenance.whenAttemptSettled()
    expect(h.spans[0]['repo.maintenance_outcome']).toBe('interrupted')
    expect(vi.getTimerCount()).toBe(0)
    expect(h.maintainPackIndex).not.toHaveBeenCalled()
    expect(h.resolveRefsDirectory).not.toHaveBeenCalled()
  })

  it('treats a canceled deadline probe as timed out without scheduling retries', async () => {
    gitExecFileAsyncMock.mockImplementationOnce(
      (_argv, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true
          })
        })
    )
    const h = createHarness()
    h.maintenance.arm(h.target)
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await elapse(h.maintenance, REF_MAINTENANCE_ATTEMPT_DEADLINE_MS)
    expect(h.spans[0]['repo.maintenance_outcome']).toBe('timed_out')
    expect(gitExecFileAsyncMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(h.maintainPackIndex).not.toHaveBeenCalled()
    expect(h.resolveRefsDirectory).not.toHaveBeenCalled()
  })
})
