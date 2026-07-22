import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OS_EXIT_POLL_INTERVAL_MS,
  SYNTHETIC_KILL_EXIT_CODE,
  Session,
  type SubprocessHandle
} from './session'

const isProcessAliveMock = vi.hoisted(() => vi.fn(() => true))
vi.mock('../pty/os-process-termination', () => ({
  isProcessAlive: isProcessAliveMock,
  killOsProcessTree: vi.fn()
}))

/**
 * Builds a SubprocessHandle that emulates a wedged ConPTY: `kill()`/`forceKill()` never fire `onExit` on
 * their own, so only the OS-pid poll or an explicit reconcile can resolve the session.
 *
 * @returns the handle, its `forceKill` spy, and `fireExit` to simulate node-pty finally reporting an exit.
 */
function createWedgedSubprocess(pid = 4242) {
  let onExit: ((code: number) => void) | null = null
  const forceKill = vi.fn()
  const handle: SubprocessHandle = {
    pid,
    getForegroundProcess: () => null,
    write: () => {},
    resize: () => {},
    kill: () => {},
    forceKill,
    signal: () => {},
    onData: () => {},
    onExit: (cb) => {
      onExit = cb
    },
    dispose: () => {}
  }
  return { handle, forceKill, fireExit: (code: number) => onExit?.(code) }
}

describe('Session wedged-ConPTY OS-exit synthesis', () => {
  let session: Session
  let sub: ReturnType<typeof createWedgedSubprocess>

  beforeEach(() => {
    vi.useFakeTimers()
    isProcessAliveMock.mockReset()
    isProcessAliveMock.mockReturnValue(true)
    sub = createWedgedSubprocess()
    session = new Session({
      sessionId: 'wedged-session',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false
    })
  })

  afterEach(() => {
    session.dispose()
    vi.useRealTimers()
  })

  it('synthesizes exit when the OS pid dies but node-pty never fires onExit', async () => {
    const exits: number[] = []
    session.attachClient({ onData: () => {}, onExit: (code) => exits.push(code) })

    const done = session.forceKillAndWaitForExit()
    await vi.advanceTimersByTimeAsync(OS_EXIT_POLL_INTERVAL_MS)
    expect(session.isAlive).toBe(true) // still alive → no synthesis yet

    isProcessAliveMock.mockReturnValue(false) // OS process is now gone
    await vi.advanceTimersByTimeAsync(OS_EXIT_POLL_INTERVAL_MS)

    expect(session.state).toBe('exited')
    expect(exits).toEqual([SYNTHETIC_KILL_EXIT_CODE])
    await expect(done).resolves.toBeUndefined()
  })

  it('prefers a real onExit over synthesis and fans out once', async () => {
    const exits: number[] = []
    session.attachClient({ onData: () => {}, onExit: (code) => exits.push(code) })

    void session.forceKillAndWaitForExit()
    sub.fireExit(0) // real onExit wins the race
    isProcessAliveMock.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(OS_EXIT_POLL_INTERVAL_MS * 2)

    expect(session.exitCode).toBe(0)
    expect(exits).toEqual([0]) // never double-fires with the synthetic code
  })

  it('reconcileWedgedExit no-ops before force-kill and reaps a dead pid after', () => {
    const exits: number[] = []
    session.attachClient({ onData: () => {}, onExit: (code) => exits.push(code) })

    isProcessAliveMock.mockReturnValue(false)
    session.reconcileWedgedExit() // not force-killed yet → no-op
    expect(session.isAlive).toBe(true)

    void session.forceKillAndWaitForExit()
    session.reconcileWedgedExit()

    expect(session.state).toBe('exited')
    expect(exits).toEqual([SYNTHETIC_KILL_EXIT_CODE])
  })

  // Why: a recycled pid also reads as alive, so re-killing off a liveness probe could destroy an unrelated
  // process tree. Escalation must be driven by a confirmed refusal, never by "it still looks alive".
  it('never re-kills from a liveness probe (pid-reuse safety)', () => {
    void session.forceKillAndWaitForExit()
    expect(sub.forceKill).toHaveBeenCalledTimes(1)

    isProcessAliveMock.mockReturnValue(true) // may be our child, or a stranger on a recycled pid
    session.reconcileWedgedExit()
    session.reconcileWedgedExit()

    expect(sub.forceKill).toHaveBeenCalledTimes(1) // no blind re-kill
    expect(session.isAlive).toBe(true)
  })

  it('re-arms after a confirmed kill refusal so the next request retries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A refusal proves the child was never terminated — the pid is still ours, so retrying is safe.
      sub.forceKill.mockImplementation((onFailure?: (error: Error) => void) => {
        onFailure?.(new Error('Access is denied'))
      })

      void session.forceKillAndWaitForExit()
      expect(sub.forceKill).toHaveBeenCalledTimes(1)

      void session.forceKillAndWaitForExit()
      expect(sub.forceKill).toHaveBeenCalledTimes(2) // re-armed, so it escalates again
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
