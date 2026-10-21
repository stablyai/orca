import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { killWithDescendantSweep, type ProcessTableCapture } from './pty-descendant-termination'
import { terminateDescendantSnapshotWithVerdict } from './pty-descendant-exit-verification'
import type { WindowsTreeKillTarget } from './windows-pty-root-identity'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const target = { pid: 20, ppid: 10, pgid: 20, startedAt: 'Mon Jul 13 12:54:47 2026' }
const capturedAtMs = Date.parse('Tue Jul 14 12:00:00 2026')
const capture: ProcessTableCapture = {
  rows: [{ ...target, pid: 10, ppid: 1, pgid: 10 }, target],
  capturedAtMs
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('main shutdown lifecycle compatibility', () => {
  it('evaluates a POSIX immediate join after snapshot capture and retains the root through verification', async () => {
    const snapshotGate = deferred<ProcessTableCapture>()
    const verificationGate = deferred<void>()
    const events: string[] = []
    let immediate = false
    const pending = killWithDescendantSweep(10, () => events.push('root'), {
      platform: 'linux',
      readTable: () => snapshotGate.promise,
      awaitEscalation: () => immediate,
      terminateDescendants: () => {
        events.push('verify')
        return verificationGate.promise
      }
    })
    immediate = true
    snapshotGate.resolve(capture)
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual(['verify'])
    verificationGate.resolve()
    await pending
    expect(events).toEqual(['verify', 'root'])
  })

  it('does not await custom POSIX verification when the predicate remains false', async () => {
    const gate = deferred<void>()
    const killRoot = vi.fn()
    await killWithDescendantSweep(10, killRoot, {
      platform: 'linux',
      readTable: async () => capture,
      awaitEscalation: () => false,
      terminateDescendants: () => gate.promise
    })
    expect(killRoot).toHaveBeenCalledOnce()
    gate.resolve()
  })

  it.each([false, true])(
    'retains the Windows root after immediate becomes %s during the probe',
    async (immediateAfterProbe) => {
      const probeGate = deferred<WindowsTreeKillTarget>()
      const killGate = deferred<void>()
      const killRoot = vi.fn()
      let immediate = false
      let settled = false
      const pending = killWithDescendantSweep(10, killRoot, {
        platform: 'win32',
        verifyTreeKillTarget: () => probeGate.promise,
        killWindowsTree: () => killGate.promise,
        awaitEscalation: () => immediate
      }).then(() => {
        settled = true
      })
      immediate = immediateAfterProbe
      probeGate.resolve('own')
      await vi.advanceTimersByTimeAsync(0)
      expect(killRoot).not.toHaveBeenCalled()
      expect(settled).toBe(false)
      killGate.resolve()
      await pending
    }
  )

  it('keeps both shutdown-verifier read deadlines alive', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const pending = terminateDescendantSnapshotWithVerdict(
        {
          rootPgid: 10,
          descendants: [target],
          capturedAtMs
        },
        {
          readTable: () => new Promise<ProcessTableCapture>(() => {}),
          sendSignal: vi.fn(),
          requireIdentityBeforeSignal: true,
          timeoutMs: 100,
          verifyMs: 100,
          keepAlive: true
        }
      )
      expect(timerSpy.mock.results[0].value.hasRef()).toBe(true)
      await vi.advanceTimersByTimeAsync(150)
      expect(timerSpy.mock.results[2].value.hasRef()).toBe(true)
      await vi.advanceTimersByTimeAsync(100)
      await expect(pending).resolves.toBe('unverifiable')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      timerSpy.mockRestore()
    }
  })
})
