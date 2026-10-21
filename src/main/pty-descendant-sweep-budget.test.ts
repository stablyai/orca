import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { killWithDescendantSweep } from './pty-descendant-termination'
import type {
  verifyWindowsTreeKillTarget,
  WindowsTreeKillTarget
} from './windows-pty-root-identity'

const verifyWindowsTreeKillTargetMock = vi.hoisted(() =>
  vi.fn<typeof verifyWindowsTreeKillTarget>()
)
vi.mock('./windows-pty-root-identity', () => ({
  verifyWindowsTreeKillTarget: verifyWindowsTreeKillTargetMock,
  WINDOWS_ROOT_IDENTITY_TIMEOUT_MS: 3000
}))

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  verifyWindowsTreeKillTargetMock.mockReset()
  verifyWindowsTreeKillTargetMock.mockResolvedValue('own')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('killWithDescendantSweep outer deadline', () => {
  it('fires killRoot by the deadline even when the identity probe hangs', async () => {
    const killRoot = vi.fn()
    let settled = false
    const pending = killWithDescendantSweep(4242, killRoot, {
      platform: 'win32',
      terminateOwnedTree: () => 'unavailable',
      verifyTreeKillTarget: (): Promise<WindowsTreeKillTarget> =>
        deferred<WindowsTreeKillTarget>().promise,
      killWindowsTree: vi.fn(),
      sweepTimeoutMs: 1000,
      awaitEscalation: true
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(killRoot).not.toHaveBeenCalled()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(killRoot).toHaveBeenCalledOnce()
    await pending
    expect(settled).toBe(true)
  })

  it('never starts taskkill from a probe that resolves after the root deadline', async () => {
    const probe = deferred<WindowsTreeKillTarget>()
    const killRoot = vi.fn()
    const killWindowsTree = vi.fn().mockResolvedValue(undefined)
    const pending = killWithDescendantSweep(4242, killRoot, {
      platform: 'win32',
      verifyTreeKillTarget: () => probe.promise,
      killWindowsTree,
      sweepTimeoutMs: 1000
    })
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(killRoot).toHaveBeenCalledOnce()
    probe.resolve('own')
    await vi.advanceTimersByTimeAsync(0)
    expect(killWindowsTree).not.toHaveBeenCalled()
    expect(killRoot).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    'retains the root during tree discovery (awaitEscalation=%p)',
    async (awaitEscalation) => {
      const tree = deferred<void>()
      const events: string[] = []
      const pending = killWithDescendantSweep(
        4242,
        () => {
          events.push('root-kill')
        },
        {
          platform: 'win32',
          verifyTreeKillTarget: async () => 'own',
          killWindowsTree: async () => {
            events.push('tree-start')
            await tree.promise
            events.push('tree-finished')
          },
          sweepTimeoutMs: 1000,
          awaitEscalation
        }
      )
      await vi.advanceTimersByTimeAsync(100)
      expect(events).toEqual(['tree-start'])
      tree.resolve()
      await pending
      expect(events).toEqual(['tree-start', 'tree-finished', 'root-kill'])
    }
  )

  it('bounds an interactive wedged tree kill even without an explicit sweep budget', async () => {
    const killRoot = vi.fn()
    const pending = killWithDescendantSweep(4242, killRoot, {
      platform: 'win32',
      verifyTreeKillTarget: async () => 'own',
      killWindowsTree: () => deferred<void>().promise
    })
    await vi.advanceTimersByTimeAsync(2399)
    expect(killRoot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(killRoot).toHaveBeenCalledOnce()
  })

  it('bounds a default wedged probe before independent 5s root escalation', async () => {
    const probe = deferred<WindowsTreeKillTarget>()
    const killRoot = vi.fn()
    const killWindowsTree = vi.fn()
    const pending = killWithDescendantSweep(4242, killRoot, {
      platform: 'win32',
      verifyTreeKillTarget: () => probe.promise,
      killWindowsTree
    })
    await vi.advanceTimersByTimeAsync(3999)
    expect(killRoot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(killRoot).toHaveBeenCalledOnce()
    probe.resolve('own')
    await vi.advanceTimersByTimeAsync(1000)
    expect(killWindowsTree).not.toHaveBeenCalled()
  })

  it('fires killRoot exactly once when the sweep settles at the deadline', async () => {
    const killRoot = vi.fn()
    const pending = killWithDescendantSweep(4242, killRoot, {
      platform: 'win32',
      terminateOwnedTree: () => 'unavailable',
      verifyTreeKillTarget: async () => 'foreign',
      killWindowsTree: vi.fn(),
      sweepTimeoutMs: 1000,
      awaitEscalation: true
    })

    await vi.advanceTimersByTimeAsync(5000)
    await pending
    expect(killRoot).toHaveBeenCalledOnce()
  })

  it('stops waiting for a wedged tree killer at the escalation share of the budget', async () => {
    const killRoot = vi.fn()
    const gate = deferred<void>()
    let settled = false
    const pending = killWithDescendantSweep(4242, killRoot, {
      platform: 'win32',
      terminateOwnedTree: () => 'unavailable',
      verifyTreeKillTarget: async () => 'own',
      killWindowsTree: () => gate.promise,
      sweepTimeoutMs: 1000,
      awaitEscalation: true
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(5000)
    await pending
    expect(settled).toBe(true)
    expect(killRoot).toHaveBeenCalledOnce()

    gate.resolve()
  })

  it.each([true, false])(
    'aborts a pending taskkill before root release (outer deadline=%p)',
    async (outerDeadline) => {
      const events: string[] = []
      const probe = deferred<WindowsTreeKillTarget>()
      const pending = killWithDescendantSweep(
        4242,
        () => {
          events.push('root-kill')
        },
        {
          platform: 'win32',
          verifyTreeKillTarget: () => probe.promise,
          killWindowsTree: (_pid, options) => {
            options?.signal?.addEventListener('abort', () => {
              events.push('taskkill-aborted')
            })
            return new Promise<void>(() => {})
          },
          sweepTimeoutMs: 1000
        }
      )
      await vi.advanceTimersByTimeAsync(outerDeadline ? 900 : 0)
      probe.resolve('own')
      await vi.advanceTimersByTimeAsync(outerDeadline ? 100 : 600)
      await pending
      expect(events).toEqual(['taskkill-aborted', 'root-kill'])
    }
  )

  it('bounds the POSIX escalation wait when the re-read hangs', async () => {
    const events: string[] = []
    const sendSignal = vi.fn((pid: number, signal: string) => events.push(`${signal}:${pid}`))
    const liveRows = [{ pid: 10, ppid: 1, pgid: 10, startedAt: 'x' }]
    const targetRows = [
      ...liveRows,
      { pid: 20, ppid: 10, pgid: 20, startedAt: 'Mon Jul 13 12:54:47 2026' }
    ]
    const readTable = vi
      .fn()
      .mockResolvedValueOnce({
        rows: targetRows,
        capturedAtMs: Date.parse('Tue Jul 14 12:00:00 2026')
      })
      .mockResolvedValueOnce({
        rows: targetRows,
        capturedAtMs: Date.parse('Tue Jul 14 12:00:00 2026')
      })
      .mockReturnValue(deferred().promise)
    const killRoot = vi.fn(() => events.push('root-kill'))
    let settled = false
    const pending = killWithDescendantSweep(10, killRoot, {
      platform: 'darwin',
      readTable,
      sendSignal,
      sweepTimeoutMs: 1000,
      awaitEscalation: true
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(5000)
    await pending
    expect(settled).toBe(true)
    expect(killRoot).toHaveBeenCalledOnce()
    expect(events).toEqual(['SIGTERM:20', 'root-kill'])
  })

  it('scales the inner probe bound from the sweep budget, not the full default', async () => {
    await killWithDescendantSweep(4242, () => {}, {
      platform: 'win32',
      terminateOwnedTree: () => 'unavailable',
      killWindowsTree: vi.fn().mockResolvedValue(undefined),
      expectedRootCreationTimeMs: 1234,
      sweepTimeoutMs: 4000
    })
    expect(verifyWindowsTreeKillTargetMock).toHaveBeenCalledOnce()
    const [, opts = {}] = verifyWindowsTreeKillTargetMock.mock.calls[0]
    expect(opts.expectedCreationTimeMs).toBe(1234)
    expect(opts.timeoutMs).toBeLessThanOrEqual(3000)
  })

  it('omits the creation-time anchor when no spawn baseline exists', async () => {
    await killWithDescendantSweep(4242, () => {}, {
      platform: 'win32',
      terminateOwnedTree: () => 'unavailable',
      killWindowsTree: vi.fn().mockResolvedValue(undefined)
    })
    expect(verifyWindowsTreeKillTargetMock).toHaveBeenCalledOnce()
    const [, opts = {}] = verifyWindowsTreeKillTargetMock.mock.calls[0]
    expect(opts.expectedCreationTimeMs).toBeUndefined()
  })
})
