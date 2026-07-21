import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRODUCER_PAUSE_FAILSAFE_MS, SESSION_FORCE_KILL_RETRY_MS, Session } from './session'
import type { SessionState, ShellReadyState } from './types'
import type { TuiAgent } from '../../shared/types'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// Stub the subprocess — Session talks to it via an interface, not child_process directly.
function createMockSubprocess() {
  const written: string[] = []
  const signals: string[] = []
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  let killed = false
  let clearCalls = 0
  let pid = 12345
  let pauseCalls = 0
  let resumeCalls = 0

  return {
    written,
    signals,
    get killed() {
      return killed
    },
    get pid() {
      return pid
    },
    get pauseCalls() {
      return pauseCalls
    },
    get resumeCalls() {
      return resumeCalls
    },
    foregroundProcess: null as string | null,
    getForegroundProcess(): string | null {
      return this.foregroundProcess
    },
    write(data: string) {
      written.push(data)
    },
    resize(_cols: number, _rows: number) {},
    pause() {
      pauseCalls++
    },
    resume() {
      resumeCalls++
    },
    get clearCalls() {
      return clearCalls
    },
    clear() {
      clearCalls++
    },
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
    dispose() {},
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
    killWithDescendantSweepMock.mockReset()
  })

  afterEach(() => {
    session?.dispose()
    vi.useRealTimers()
  })

  function createSession(opts?: {
    shellReadySupported?: boolean
    shellReadyTimeoutMs?: number
    cols?: number
    rows?: number
    launchAgent?: TuiAgent
    startupIngress?: {
      colors: { foreground: string; background: string }
      deadlineMs: number
    }
    ownerBackend?: 'posix-pty' | 'windows-conpty' | 'windows-wsl'
    wslDistro?: string
  }): Session {
    session = new Session({
      sessionId: 'test-session',
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
      ...(opts?.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      wslDistro: opts?.wslDistro,
      subprocess,
      ...(opts?.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
      shellReadySupported: opts?.shellReadySupported ?? false,
      ...(opts?.startupIngress ? { startupIngress: opts.startupIngress } : {}),
      ...(opts?.shellReadyTimeoutMs !== undefined
        ? { shellReadyTimeoutMs: opts.shellReadyTimeoutMs }
        : {})
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

    it('classifies startup queries and cooked echoes before model, persistence, and fanout', () => {
      createSession({
        ownerBackend: 'windows-conpty',
        startupIngress: {
          colors: { foreground: '#2e3434', background: '#ffffff' },
          deadlineMs: 5_000
        }
      })
      const onData = vi.fn()
      session.attachClient({ onData, onExit: () => {} })
      const query = '\x1b]10;?\x07'
      const echo = ']10;rgb:2e2e/3434/3434\\'

      subprocess.simulateData(query)
      subprocess.simulateData(echo)
      subprocess.simulateData('prompt')

      expect(subprocess.written).toEqual(['\x1b]10;rgb:2e2e/3434/3434\x1b\\'])
      expect(onData.mock.calls).toEqual([
        ['', query.length, true, query.length],
        ['', echo.length, true, query.length + echo.length],
        ['prompt']
      ])
      expect(session.takePendingOutput(false)?.records).toEqual([
        { kind: 'output', data: 'prompt' }
      ])
      expect(session.getSnapshot()).toMatchObject({
        outputSequence: query.length + echo.length + 'prompt'.length
      })
      expect(session.getSnapshot()?.snapshotAnsi).toContain('prompt')
      expect(session.getSnapshot()?.snapshotAnsi).not.toContain(']10;rgb')
    })

    it('releases a held cooked-echo prefix before taking a snapshot', () => {
      createSession({
        ownerBackend: 'windows-conpty',
        startupIngress: {
          colors: { foreground: '#2e3434', background: '#ffffff' },
          deadlineMs: 5_000
        }
      })
      subprocess.simulateData('\x1b]10;?\x07')
      subprocess.simulateData(']10;rgb:2e2e/')

      const snapshot = session.getSnapshot()

      expect(snapshot?.snapshotAnsi).toContain(']10;rgb:2e2e/')
      expect(snapshot?.outputSequence).toBe('\x1b]10;?\x07]10;rgb:2e2e/'.length)
    })

    it('reproduces the legacy paired-runtime leak and removes its downstream producer', () => {
      const query = '\x1b]10;?\x07'
      const reply = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'
      const projectedEcho = ']10;rgb:2e2e/3434/3434\\'
      createSession({ ownerBackend: 'posix-pty' })
      session.closeStartupQueryAuthority()
      const legacyReplyProducers: string[] = []
      const legacyOnData = vi.fn((data: string) => {
        if (data === query) {
          legacyReplyProducers.push('remote-visible-renderer')
          session.write(reply)
          if (subprocess.written.at(-1) === reply) {
            subprocess.simulateData(projectedEcho)
          }
        }
      })
      session.attachClient({ onData: legacyOnData, onExit: () => {} })

      subprocess.simulateData(query)

      expect(legacyReplyProducers).toEqual(['remote-visible-renderer'])
      expect(subprocess.written).toEqual([reply])
      expect(legacyOnData.mock.calls).toEqual([[query], [projectedEcho]])
      expect(session.getSnapshot()?.snapshotAnsi).toContain(projectedEcho)
      session.dispose()

      subprocess = createMockSubprocess()
      createSession({ ownerBackend: 'windows-conpty' })
      session.closeStartupQueryAuthority()
      const fixedReplyProducers: string[] = []
      const fixedOnData = vi.fn((data: string) => {
        if (data === query) {
          fixedReplyProducers.push('remote-visible-renderer')
          session.write(reply)
        }
      })
      session.attachClient({ onData: fixedOnData, onExit: () => {} })

      subprocess.simulateData(query)
      subprocess.simulateData('prompt')

      expect(fixedReplyProducers).toEqual([])
      expect(subprocess.written).toEqual([])
      expect(fixedOnData.mock.calls).toEqual([['', query.length, true, query.length], ['prompt']])
      expect(session.getSnapshot()?.snapshotAnsi).not.toContain(']10;rgb')
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
    // handleSubprocessData forwards bytes onward — so any auto-reply it
    // emits races ahead of the live answerer and clobbers it with
    // default-xterm values (no theme, stale cursor). Query authority is
    // structural (terminal-query-authority.md): a delivered chunk is
    // answered by the consuming view's xterm, a hidden-dropped chunk by
    // MAIN's runtime model responder. The daemon emulator is neither — it
    // stays write-only forever, and these pins are permanent.
    it.each([
      ['OSC 10 foreground-color', '\x1b]10;?\x07'],
      ['OSC 11 background-color', '\x1b]11;?\x07'],
      ['OSC 12 cursor-color', '\x1b]12;?\x1b\\'],
      ['DA1 device-attributes', '\x1b[c'],
      ['DA2 secondary device-attributes', '\x1b[>c'],
      ['DSR terminal status', '\x1b[5n'],
      ['DSR cursor-position', '\x1b[6n'],
      ['DECRPM bracketed-paste mode', '\x1b[?2004$p']
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
    // Why: regression guard for "claude claude" double-echo. The marker fires
    // from precmd before readline switches the PTY into raw mode; flushing
    // then lets the kernel re-echo the command under the prompt. Detailed
    // timing behavior is covered by post-ready-flush-gate.test.ts.
    // Also checks writes that arrive during the gate window keep their order
    // — the gate continues to queue even though shellState is already 'ready'.
    it('defers flush past the shell-ready marker and preserves write order', () => {
      createSession({ shellReadySupported: true })
      expect(session.shellState).toBe('pending')

      session.write('first\n')
      subprocess.simulateData('\x1b]777;orca-shell-ready\x07')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      session.write('second\n')
      expect(subprocess.written).toEqual([])

      subprocess.simulateData('\r\nuser@host $ ')
      vi.advanceTimersByTime(30)
      expect(subprocess.written).toEqual(['first\n', 'second\n'])
    })

    it('uses the short settle path when marker and prompt bytes arrive together', () => {
      createSession({ shellReadySupported: true })
      session.write('codex\n')

      subprocess.simulateData('\x1b]777;orca-shell-ready\x07\r\nuser@host $ ')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      vi.advanceTimersByTime(29)
      expect(subprocess.written).toEqual([])

      vi.advanceTimersByTime(1)
      expect(subprocess.written).toEqual(['codex\n'])
    })

    it('does not treat bytes before the marker as post-marker prompt output', () => {
      createSession({ shellReadySupported: true })
      session.write('codex\n')

      subprocess.simulateData('last login\r\n\x1b]777;orca-shell-ready\x07')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      vi.advanceTimersByTime(30)
      expect(subprocess.written).toEqual([])

      subprocess.simulateData('\r\nuser@host $ ')
      vi.advanceTimersByTime(30)
      expect(subprocess.written).toEqual(['codex\n'])
    })

    it('strips shell-ready marker bytes before client and pending-output fan-out', () => {
      createSession({ shellReadySupported: true })
      const received: string[] = []
      session.attachClient({
        onData: (data) => received.push(data),
        onExit: () => {}
      })

      subprocess.simulateData('hello \x1b]777;orca-shell-ready\x07% ')

      expect(received).toEqual(['hello % '])
      expect(session.takePendingOutput(false)?.records).toEqual([
        { kind: 'output', data: 'hello % ' }
      ])
      expect(session.getSnapshot()?.snapshotAnsi).toContain('hello % ')
      expect(session.getSnapshot()?.snapshotAnsi).not.toContain('orca-shell-ready')
    })

    it('publishes an absolute output sequence with live snapshots', () => {
      createSession()
      subprocess.simulateData('first')
      subprocess.simulateData('🟢second')

      expect(session.getSnapshot()?.outputSequence).toBe('first🟢second'.length)
      expect(session.takePendingOutput(true)?.snapshot?.outputSequence).toBe('first🟢second'.length)
    })

    it('releases held marker-prefix bytes before flushing queued input on timeout', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 100 })
      const received: string[] = []
      session.attachClient({
        onData: (data) => received.push(data),
        onExit: () => {}
      })

      subprocess.simulateData('\x1b]777;orca-shell-ready')
      session.write('codex\n')
      vi.advanceTimersByTime(100)

      expect(session.shellState).toBe('timed_out' satisfies ShellReadyState)
      expect(received).toEqual(['\x1b]777;orca-shell-ready'])
      expect(session.takePendingOutput(false)?.records).toEqual([
        { kind: 'output', data: '\x1b]777;orca-shell-ready' }
      ])
      expect(subprocess.written).toEqual(['codex\n'])
    })

    it('releases held marker-prefix bytes when the subprocess exits before readiness', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 100 })
      const received: string[] = []
      session.attachClient({
        onData: (data) => received.push(data),
        onExit: () => {}
      })

      subprocess.simulateData('\x1b]777;orca-shell-ready')
      subprocess.simulateExit(0)

      expect(received).toEqual(['\x1b]777;orca-shell-ready'])
      expect(session.takePendingOutput(false)?.records).toEqual([
        { kind: 'output', data: '\x1b]777;orca-shell-ready' }
      ])
    })

    it('keeps held marker-prefix bytes during live take-with-snapshot', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 100 })
      session.write('codex\n')

      subprocess.simulateData('\x1b]777;orca-shell-ready')
      const taken = session.takePendingOutput(true)
      subprocess.simulateData('\x07\r\nuser@host $ ')
      vi.advanceTimersByTime(30)

      expect(taken?.records).toEqual([])
      expect(taken?.snapshot).toBeTruthy()
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      expect(subprocess.written).toEqual(['codex\n'])
    })

    it('releases held marker-prefix bytes before final take-with-snapshot', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 100 })

      subprocess.simulateData('\x1b]777;orca-shell-ready')
      const taken = session.takePendingOutput(true, { teardownSnapshot: true })

      expect(taken?.records).toEqual([{ kind: 'output', data: '\x1b]777;orca-shell-ready' }])
      expect(taken?.snapshot).toBeTruthy()
    })

    it('cancels the post-ready flush gate when force-disposing the subprocess', async () => {
      createSession({ shellReadySupported: true })
      session.write('codex\n')

      subprocess.simulateData('\x1b]777;orca-shell-ready\x07')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      const dispose = session.forceKillAndDisposeSubprocess()
      subprocess.simulateExit(137)
      await dispose
      vi.advanceTimersByTime(500)

      expect(subprocess.written).toEqual([])
    })

    it('transitions to timed_out after 15 seconds', () => {
      createSession({ shellReadySupported: true })
      session.write('waiting input')

      vi.advanceTimersByTime(15_000)

      expect(session.shellState).toBe('timed_out' satisfies ShellReadyState)
      expect(subprocess.written).toEqual(['waiting input'])
    })

    it('honors a shorter shell-ready timeout for Codex startup sessions', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 300 })
      session.write('codex\n')

      vi.advanceTimersByTime(299)
      expect(subprocess.written).toEqual([])

      vi.advanceTimersByTime(1)
      expect(session.shellState).toBe('timed_out' satisfies ShellReadyState)
      expect(subprocess.written).toEqual(['codex\n'])
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

    it('allows a graceful retry when the first kill is rejected', () => {
      let attempts = 0
      subprocess.kill = () => {
        attempts++
        if (attempts === 1) {
          throw new Error('graceful kill rejected')
        }
      }
      createSession()

      expect(() => session.kill()).toThrow('graceful kill rejected')
      expect(session.isTerminating).toBe(false)
      expect(() => session.kill()).not.toThrow()

      expect(attempts).toBe(2)
      expect(session.isTerminating).toBe(true)
    })

    it('non-agent kill stays synchronous and never routes through the descendant sweep', () => {
      createSession()
      session.kill()
      expect(subprocess.killed).toBe(true)
      expect(killWithDescendantSweepMock).not.toHaveBeenCalled()
    })

    it('agent kill routes through the descendant sweep with the subprocess as root', () => {
      createSession({ launchAgent: 'claude' })
      session.kill()
      expect(killWithDescendantSweepMock).toHaveBeenCalledWith(
        subprocess.pid,
        expect.any(Function),
        expect.objectContaining({ ownsRoot: expect.any(Function) })
      )
      // The root kill is deferred to the sweep's snapshot-first sequencing.
      expect(subprocess.killed).toBe(false)
      const killRoot = killWithDescendantSweepMock.mock.calls[0][1] as () => void
      killRoot()
      expect(subprocess.killed).toBe(true)
    })

    it('agent kill root callback is a no-op after the session already exited', () => {
      createSession({ launchAgent: 'claude' })
      session.kill()
      const killRoot = killWithDescendantSweepMock.mock.calls[0][1] as () => void
      subprocess.simulateExit(0)
      killRoot()
      expect(subprocess.killed).toBe(false)
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

    it('force-kills after 5s but retains ownership until subprocess exit', () => {
      createSession()
      // Override kill to NOT trigger exit
      subprocess.kill = () => {}
      const forceKillSpy = vi.spyOn(subprocess, 'forceKill')

      session.kill()
      expect(session.state).not.toBe('exited')

      vi.advanceTimersByTime(5_000)
      expect(forceKillSpy).toHaveBeenCalled()
      expect(session.state).toBe('running')
      expect(session.isTerminating).toBe(true)

      subprocess.simulateExit(137)
      expect(session.state).toBe('exited')
    })

    it('retries a rejected destructive force kill while retaining ownership', async () => {
      let forceKillAttempts = 0
      subprocess.forceKill = () => {
        forceKillAttempts++
        if (forceKillAttempts === 1) {
          throw new Error('force kill rejected')
        }
      }
      createSession()

      const shutdown = session.forceKillAndWaitForExit()
      expect(forceKillAttempts).toBe(1)
      await vi.advanceTimersByTimeAsync(SESSION_FORCE_KILL_RETRY_MS)
      expect(forceKillAttempts).toBe(2)
      subprocess.simulateExit(137)
      await shutdown

      expect(session.state).toBe('exited')
    })

    it('retries a rejected graceful-deadline force kill', async () => {
      subprocess.kill = () => {}
      let forceKillAttempts = 0
      subprocess.forceKill = () => {
        forceKillAttempts++
        if (forceKillAttempts === 1) {
          throw new Error('transient graceful fallback failure')
        }
      }
      createSession()

      session.kill()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(forceKillAttempts).toBe(1)
      expect(session.isTerminating).toBe(true)

      await vi.advanceTimersByTimeAsync(SESSION_FORCE_KILL_RETRY_MS)
      expect(forceKillAttempts).toBe(2)
      subprocess.simulateExit(137)
      expect(session.state).toBe('exited')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps late data and the real exit code until physical exit', () => {
      createSession()
      subprocess.kill = () => {}
      const onData = vi.fn()
      const onExit = vi.fn()
      session.attachClient({ onData, onExit })

      session.kill()
      vi.advanceTimersByTime(5_000)

      subprocess.simulateData('late output')
      subprocess.simulateExit(23)

      expect(onData).toHaveBeenCalledWith('late output')
      expect(onExit).toHaveBeenCalledTimes(1)
      expect(onExit).toHaveBeenCalledWith(23)
      expect(session.exitCode).toBe(23)
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

  describe('clearScrollback', () => {
    function withPlatform(platform: NodeJS.Platform, run: () => void): void {
      const original = process.platform
      Object.defineProperty(process, 'platform', { value: platform })
      try {
        run()
      } finally {
        Object.defineProperty(process, 'platform', { value: original })
      }
    }

    it('resyncs the native PTY screen state alongside the emulator clear', () => {
      createSession()
      session.clearScrollback()
      // Why: without the subprocess clear, ConPTY keeps a stale cursor row and
      // the next prompt repaint lands below a blank gap on Windows.
      expect(subprocess.clearCalls).toBe(1)
      const take = session.takePendingOutput(false)
      expect(take?.records).toContainEqual({ kind: 'clear' })
    })

    it('nudges a Windows PowerShell prompt to repaint with a form feed', async () => {
      createSession()
      subprocess.foregroundProcess = 'powershell.exe'
      subprocess.simulateData('PS C:\\Users\\me> ')
      await vi.advanceTimersByTimeAsync(10)
      withPlatform('win32', () => session.clearScrollback())
      // Why: the ConPTY clear cannot reach PSReadLine's cached cursor row;
      // Ctrl+L makes PSReadLine repaint the prompt at the true origin.
      expect(subprocess.written).toEqual(['\x0c'])
    })

    it('does not send a form feed while input is pending at the prompt', async () => {
      createSession()
      subprocess.foregroundProcess = 'powershell.exe'
      subprocess.simulateData('PS C:\\Users\\me> fd')
      await vi.advanceTimersByTimeAsync(10)
      // Why: PSReadLine repaints pending input at a stale cached row that
      // ConPTY's fixed viewport doesn't track, so the nudge must be skipped.
      withPlatform('win32', () => session.clearScrollback())
      expect(subprocess.written).toEqual([])
    })

    it('does not send or queue a form feed before shell-ready', async () => {
      createSession({ shellReadySupported: true })
      subprocess.foregroundProcess = 'powershell.exe'
      subprocess.simulateData('PS C:\\Users\\me> ')
      await vi.advanceTimersByTimeAsync(10)
      // Why: a queued form feed would flush after the startup command at an
      // arbitrary later moment, when the prompt gates no longer hold.
      withPlatform('win32', () => session.clearScrollback())
      expect(subprocess.written).toEqual([])
      subprocess.simulateData('\x1b]777;orca-shell-ready\x07\r\nPS C:\\Users\\me> ')
      await vi.advanceTimersByTimeAsync(10)
      expect(subprocess.written).toEqual([])
    })

    it('does not send a form feed at a PowerShell continuation prompt', async () => {
      createSession()
      subprocess.foregroundProcess = 'powershell.exe'
      subprocess.simulateData('PS C:\\Users\\me> {\r\n>> ')
      await vi.advanceTimersByTimeAsync(10)
      withPlatform('win32', () => session.clearScrollback())
      expect(subprocess.written).toEqual([])
    })

    it('does not send a form feed while a command owns the foreground', async () => {
      createSession()
      subprocess.foregroundProcess = 'node'
      subprocess.simulateData('PS C:\\Users\\me> ')
      await vi.advanceTimersByTimeAsync(10)
      withPlatform('win32', () => session.clearScrollback())
      expect(subprocess.written).toEqual([])
    })

    it('does not send a form feed on POSIX platforms', async () => {
      createSession()
      subprocess.foregroundProcess = 'pwsh'
      subprocess.simulateData('PS C:\\Users\\me> ')
      await vi.advanceTimersByTimeAsync(10)
      withPlatform('linux', () => session.clearScrollback())
      expect(subprocess.written).toEqual([])
    })

    it('does not touch the subprocess after dispose', () => {
      createSession()
      session.dispose()
      session.clearScrollback()
      expect(subprocess.clearCalls).toBe(0)
    })
  })

  describe('snapshot', () => {
    it('parses live OSC-7 output in the session WSL distro', () => {
      createSession({ wslDistro: 'Ubuntu' })

      subprocess.simulateData('\x1b]7;file://DESKTOP-ORCA/home/jin/repo\x07')

      expect(session.getCwd()).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
    })
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

  describe('producer flow control', () => {
    it('pauses the subprocess and auto-resumes via the lost-resume failsafe', () => {
      createSession()
      session.pauseProducer()
      expect(subprocess.pauseCalls).toBe(1)
      expect(subprocess.resumeCalls).toBe(0)

      vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS - 1)
      expect(subprocess.resumeCalls).toBe(0)
      vi.advanceTimersByTime(1)
      expect(subprocess.resumeCalls).toBe(1)
    })

    it('resumeProducer resumes once and cancels the failsafe timer', () => {
      createSession()
      session.pauseProducer()
      session.resumeProducer()
      expect(subprocess.resumeCalls).toBe(1)

      vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS * 2)
      expect(subprocess.resumeCalls).toBe(1)
    })

    it('resumeProducer without a matching pause is a no-op', () => {
      createSession()
      session.resumeProducer()
      expect(subprocess.resumeCalls).toBe(0)
    })

    it('re-pausing re-arms the failsafe window', () => {
      createSession()
      session.pauseProducer()
      vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS - 1_000)
      session.pauseProducer()

      vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS - 1)
      expect(subprocess.resumeCalls).toBe(0)
      vi.advanceTimersByTime(1)
      expect(subprocess.resumeCalls).toBe(1)
    })

    it('kill() resumes a paused producer before signalling the child', () => {
      createSession()
      session.pauseProducer()
      session.kill()
      expect(subprocess.resumeCalls).toBe(1)
      expect(subprocess.killed).toBe(true)
    })

    it('dispose() resumes a paused producer and clears the failsafe', () => {
      createSession()
      session.pauseProducer()
      session.dispose()
      expect(subprocess.resumeCalls).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('subprocess exit clears the failsafe without resuming a reaped child', () => {
      createSession()
      session.pauseProducer()
      subprocess.simulateExit(0)
      vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS * 2)
      expect(subprocess.resumeCalls).toBe(0)
    })

    it('ignores pauseProducer on an exited session', () => {
      createSession()
      subprocess.simulateExit(0)
      session.pauseProducer()
      expect(subprocess.pauseCalls).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('detaching the last client resumes a paused producer', () => {
      createSession()
      const token = session.attachClient({ onData: () => {}, onExit: () => {} })
      session.pauseProducer()
      session.detachClient(token)
      expect(subprocess.resumeCalls).toBe(1)
    })

    it('keeps the pause while another client is still attached', () => {
      createSession()
      const token = session.attachClient({ onData: () => {}, onExit: () => {} })
      session.attachClient({ onData: () => {}, onExit: () => {} })
      session.pauseProducer()
      session.detachClient(token)
      expect(subprocess.resumeCalls).toBe(0)
    })

    it('detachAllClients resumes a paused producer', () => {
      createSession()
      session.attachClient({ onData: () => {}, onExit: () => {} })
      session.pauseProducer()
      session.detachAllClients()
      expect(subprocess.resumeCalls).toBe(1)
    })
  })
})
