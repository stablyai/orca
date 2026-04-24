import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import type { SessionState, ShellReadyState } from './types'

// Stub the subprocess — Session talks to it via an interface, not child_process directly.
function createMockSubprocess() {
  const written: string[] = []
  const signals: string[] = []
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  let killed = false
  let pid = 12345

  return {
    written,
    signals,
    get killed() {
      return killed
    },
    get pid() {
      return pid
    },
    write(data: string) {
      written.push(data)
    },
    resize(_cols: number, _rows: number) {},
    kill() {
      killed = true
      // Simulate async exit
      setTimeout(() => onExit?.(0), 5)
    },
    forceKill() {
      killed = true
    },
    signal(sig: string) {
      signals.push(sig)
    },
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit(cb: (code: number) => void) {
      onExit = cb
    },
    // Helpers for tests to simulate subprocess events
    simulateData(data: string) {
      onData?.(data)
    },
    simulateExit(code: number) {
      onExit?.(code)
    }
  }
}

type MockSubprocess = ReturnType<typeof createMockSubprocess>

describe('Session', () => {
  let session: Session
  let subprocess: MockSubprocess

  beforeEach(() => {
    vi.useFakeTimers()
    subprocess = createMockSubprocess()
  })

  afterEach(() => {
    session?.dispose()
    vi.useRealTimers()
  })

  function createSession(opts?: {
    shellReadySupported?: boolean
    cols?: number
    rows?: number
  }): Session {
    session = new Session({
      sessionId: 'test-session',
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
      subprocess,
      shellReadySupported: opts?.shellReadySupported ?? false
    })
    return session
  }

  describe('state machine', () => {
    it('starts in running state when shell readiness is not supported', () => {
      createSession({ shellReadySupported: false })
      expect(session.state).toBe('running' satisfies SessionState)
      expect(session.shellState).toBe('unsupported' satisfies ShellReadyState)
    })

    it('starts in running state with pending shell when readiness is supported', () => {
      createSession({ shellReadySupported: true })
      expect(session.state).toBe('running')
      expect(session.shellState).toBe('pending' satisfies ShellReadyState)
    })

    it('transitions to exited when subprocess exits', () => {
      createSession()
      subprocess.simulateExit(0)
      expect(session.state).toBe('exited' satisfies SessionState)
      expect(session.isAlive).toBe(false)
    })

    it('tracks exit code', () => {
      createSession()
      subprocess.simulateExit(42)
      expect(session.exitCode).toBe(42)
    })
  })

  describe('data flow', () => {
    it('forwards subprocess data to attached clients', () => {
      createSession()
      const received: string[] = []
      session.attachClient({
        onData: (data) => received.push(data),
        onExit: () => {}
      })

      subprocess.simulateData('hello')
      expect(received).toEqual(['hello'])
    })

    it('does not deliver data to detached clients', () => {
      createSession()
      const received: string[] = []
      const token = session.attachClient({
        onData: (data) => received.push(data),
        onExit: () => {}
      })

      session.detachClient(token)
      subprocess.simulateData('should not arrive')
      expect(received).toEqual([])
    })

    it('supports multiple attached clients', () => {
      createSession()
      const received1: string[] = []
      const received2: string[] = []
      session.attachClient({ onData: (d) => received1.push(d), onExit: () => {} })
      session.attachClient({ onData: (d) => received2.push(d), onExit: () => {} })

      subprocess.simulateData('broadcast')
      expect(received1).toEqual(['broadcast'])
      expect(received2).toEqual(['broadcast'])
    })
  })

  describe('write', () => {
    it('forwards writes to subprocess when running', () => {
      createSession({ shellReadySupported: false })
      session.write('ls\n')
      expect(subprocess.written).toEqual(['ls\n'])
    })
  })

  describe('emulator does not reply to terminal queries', () => {
    // Why: daemon emulator parses in-process synchronously — before
    // handleSubprocessData forwards bytes to the renderer over IPC — so any
    // auto-reply it emits races ahead of the renderer's xterm and clobbers
    // it with default-xterm values (no theme, stale cursor). The renderer is
    // the authoritative responder; a daemon-side reply to any query is a bug.
    it.each([
      ['OSC 11 background-color', '\x1b]11;?\x07'],
      ['DA1 device-attributes', '\x1b[c'],
      ['DSR cursor-position', '\x1b[6n']
    ])('does not reply to %s query', async (_label, query) => {
      createSession({ shellReadySupported: false })
      subprocess.simulateData(query)
      // xterm.js fires terminal.write's completion callback via a microtask;
      // two resolved-promise awaits flush any nested scheduling.
      await Promise.resolve()
      await Promise.resolve()
      expect(subprocess.written).toEqual([])
    })
  })

  describe('shell readiness gating', () => {
    it('buffers writes during pending state', () => {
      createSession({ shellReadySupported: true })
      expect(session.shellState).toBe('pending')

      session.write('buffered input')
      expect(subprocess.written).toEqual([])
    })

    it('flushes buffered writes when shell marker is detected', () => {
      createSession({ shellReadySupported: true })

      session.write('pre-ready input')
      expect(subprocess.written).toEqual([])

      // Simulate the shell marker arriving in PTY output
      subprocess.simulateData('\x1b]777;orca-shell-ready\x07')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      expect(subprocess.written).toEqual(['pre-ready input'])
    })

    it('transitions to timed_out after 15 seconds', () => {
      createSession({ shellReadySupported: true })
      session.write('waiting input')

      vi.advanceTimersByTime(15_000)

      expect(session.shellState).toBe('timed_out' satisfies ShellReadyState)
      expect(subprocess.written).toEqual(['waiting input'])
    })

    it('detects marker split across data chunks', () => {
      createSession({ shellReadySupported: true })

      subprocess.simulateData('\x1b]777;orca-sh')
      expect(session.shellState).toBe('pending')

      subprocess.simulateData('ell-ready\x07')
      expect(session.shellState).toBe('ready')
    })
  })

  describe('kill', () => {
    it('kills the subprocess', () => {
      createSession()
      session.kill()
      expect(subprocess.killed).toBe(true)
      expect(session.isTerminating).toBe(true)
    })

    it('notifies attached clients on exit after kill', async () => {
      vi.useRealTimers()
      createSession()
      const exitCodes: number[] = []
      session.attachClient({
        onData: () => {},
        onExit: (code) => exitCodes.push(code)
      })

      session.kill()

      // Wait for the simulated async exit
      await new Promise((r) => setTimeout(r, 20))
      expect(exitCodes).toEqual([0])
    })

    it('force-disposes after 5s if subprocess does not exit', () => {
      createSession()
      // Override kill to NOT trigger exit
      subprocess.kill = () => {}
      const forceKillSpy = vi.spyOn(subprocess, 'forceKill')

      session.kill()
      expect(session.state).not.toBe('exited')

      vi.advanceTimersByTime(5_000)
      expect(session.state).toBe('exited')
      expect(forceKillSpy).toHaveBeenCalled()
    })

    it('ignores late data and exit after force-dispose', () => {
      createSession()
      subprocess.kill = () => {}
      const onData = vi.fn()
      const onExit = vi.fn()
      session.attachClient({ onData, onExit })

      session.kill()
      vi.advanceTimersByTime(5_000)

      subprocess.simulateData('late output')
      subprocess.simulateExit(23)

      expect(onData).not.toHaveBeenCalled()
      expect(onExit).toHaveBeenCalledTimes(1)
      expect(onExit).toHaveBeenCalledWith(-1)
      expect(session.exitCode).toBe(-1)
    })
  })

  describe('signal', () => {
    it('forwards signal to subprocess without entering terminating state', () => {
      createSession()
      session.signal('SIGINT')
      expect(subprocess.signals).toEqual(['SIGINT'])
      expect(session.isTerminating).toBe(false)
    })
  })

  describe('snapshot', () => {
    it('returns a terminal snapshot', async () => {
      createSession()
      subprocess.simulateData('$ hello\r\n')
      // Give emulator time to process
      await vi.advanceTimersByTimeAsync(10)

      const snapshot = session.getSnapshot()
      expect(snapshot).toBeDefined()
      expect(snapshot!.cols).toBe(80)
      expect(snapshot!.rows).toBe(24)
    })

    it('returns null after session is disposed', () => {
      createSession()
      session.dispose()
      expect(session.getSnapshot()).toBeNull()
    })
  })

  describe('resize', () => {
    it('resizes the emulator and subprocess', () => {
      createSession()
      const resizeSpy = vi.spyOn(subprocess, 'resize')
      session.resize(120, 40)
      expect(resizeSpy).toHaveBeenCalledWith(120, 40)
    })

    it('same-dim resize passes through without tricks', () => {
      createSession({ cols: 80, rows: 24 })
      const resizeSpy = vi.spyOn(subprocess, 'resize')
      session.resize(80, 24)
      expect(resizeSpy).toHaveBeenCalledTimes(1)
      expect(resizeSpy).toHaveBeenCalledWith(80, 24)
    })
  })

  describe('detach token guard', () => {
    it('ignores stale detach with wrong token', () => {
      createSession()
      const received: string[] = []
      const token1 = session.attachClient({
        onData: (d) => received.push(d),
        onExit: () => {}
      })

      // Attach a second client (same conceptual slot but new token)
      session.attachClient({
        onData: (d) => received.push(d),
        onExit: () => {}
      })

      // Try detaching with the old token — should only remove token1's client
      session.detachClient(token1)
      received.length = 0

      subprocess.simulateData('after detach')
      // token2's client should still receive data
      expect(received).toEqual(['after detach'])
    })
  })

  describe('dispose', () => {
    it('cleans up without throwing', () => {
      createSession()
      expect(() => session.dispose()).not.toThrow()
    })

    it('marks session as exited', () => {
      createSession()
      session.dispose()
      expect(session.state).toBe('exited')
    })
  })
})
