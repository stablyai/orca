import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { TerminalSessionTeardown } from './terminal-session-teardown'
import { SESSION_FORCE_KILL_RETRY_MS } from './session-termination-controller'
import type { SessionState, ShellReadyState } from './types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  _resetPtyOwnerHostColorsForTest,
  setPtyOwnerHostColors
} from '../../shared/pty-owner-color-query-colors'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

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
    confirmShellForeground: vi.fn(async () => true),
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
      setTimeout(() => onExit?.(0), 5)
    },
    terminateOwnedTree: () => 'terminated' as const,
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
    reportReadinessEvent?: (event: string, details: Record<string, unknown>) => void
    historySeedChunks?: readonly string[]
  }): Session {
    session = new Session({
      sessionId: 'test-session',
      ...(opts?.reportReadinessEvent ? { reportReadinessEvent: opts.reportReadinessEvent } : {}),
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
      ...(opts?.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      wslDistro: opts?.wslDistro,
      subprocess,
      historySeedChunks: opts?.historySeedChunks,
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
    it('does not confirm shell ownership from historical replay bytes', () => {
      createSession({
        historySeedChunks: ['\x1b[?1049hOLD-TUI\x1b]133;D;137\x07old-shell-marker']
      })

      expect(subprocess.confirmShellForeground).not.toHaveBeenCalled()
      expect(session.getSnapshot()?.terminalOwner).toBeUndefined()
    })

    it('answers concurrent runtime confirmations from one episode inspection', async () => {
      let resolveConfirmation: ((confirmed: boolean) => void) | undefined
      subprocess.confirmShellForeground.mockImplementation(
        () => new Promise((resolve) => void (resolveConfirmation = resolve))
      )
      createSession()

      // Reading a verdict must not create process proof without a byte-stream candidate.
      await expect(session.confirmShellForeground()).resolves.toBe(false)
      expect(subprocess.confirmShellForeground).not.toHaveBeenCalled()

      subprocess.simulateData('\x1b[?1049hTUI\x1b]133;D;137\x07')
      const first = session.confirmShellForeground()
      const second = session.confirmShellForeground()
      expect(subprocess.confirmShellForeground).toHaveBeenCalledTimes(1)
      resolveConfirmation?.(true)

      await expect(Promise.all([first, second])).resolves.toEqual([true, true])
      expect(subprocess.confirmShellForeground).toHaveBeenCalledTimes(1)
    })

    it('reuses the parser confirmation for a concurrent runtime request', async () => {
      let resolveConfirmation: ((confirmed: boolean) => void) | undefined
      subprocess.confirmShellForeground.mockImplementation(
        () => new Promise((resolve) => void (resolveConfirmation = resolve))
      )
      createSession()

      subprocess.simulateData('\x1b[?1049hTUI\x1b]133;D;137\x07shell-marker')
      const runtimeConfirmation = session.confirmShellForeground()
      expect(subprocess.confirmShellForeground).toHaveBeenCalledTimes(1)
      resolveConfirmation?.(true)

      await expect(runtimeConfirmation).resolves.toBe(true)
      await vi.waitFor(() => expect(session.getSnapshot()?.terminalOwner).toBe('shell'))
    })

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

    it('answers a late query itself on every backend, so no downstream view is asked', () => {
      const query = '\x1b]10;?\x07'
      const reply = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'
      for (const ownerBackend of ['posix-pty', 'windows-conpty'] as const) {
        subprocess = createMockSubprocess()
        createSession({ ownerBackend })
        session.closeStartupQueryAuthority()
        const downstreamReplies: string[] = []
        const onData = vi.fn((data: string) => {
          if (data.includes(query)) {
            downstreamReplies.push(data)
            session.write(reply)
          }
        })
        session.attachClient({ onData, onExit: () => {} })

        subprocess.simulateData(query)
        subprocess.simulateData('prompt')

        expect(downstreamReplies, ownerBackend).toEqual([])
        expect(subprocess.written, ownerBackend).toEqual([reply])
        expect(onData.mock.calls, ownerBackend).toEqual([
          ['', query.length, true, query.length],
          ['prompt']
        ])
        expect(session.getSnapshot()?.snapshotAnsi, ownerBackend).not.toContain(']10;rgb')
        session.dispose()
      }
    })

    it('answers from the daemon-wide colours pushed after the session started', () => {
      createSession({
        startupIngress: {
          colors: { foreground: '#2e3434', background: '#ffffff' },
          deadlineMs: 5_000
        }
      })

      subprocess.simulateData('\x1b]11;?\x07')
      try {
        setPtyOwnerHostColors({ foreground: '#000000', background: '#123456' })
        subprocess.simulateData('\x1b]11;?\x07')
      } finally {
        _resetPtyOwnerHostColorsForTest()
      }

      expect(subprocess.written).toEqual([
        '\x1b]11;rgb:ffff/ffff/ffff\x1b\\',
        '\x1b]11;rgb:1212/3434/5656\x1b\\'
      ])
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
    // The emulator must not race the authoritative responder; source ingress alone owns OSC 10/11.
    it.each([
      ['OSC 12 cursor-color', '\x1b]12;?\x1b\\'],
      ['DA1 device-attributes', '\x1b[c'],
      ['DA2 secondary device-attributes', '\x1b[>c'],
      ['DSR terminal status', '\x1b[5n'],
      ['DSR cursor-position', '\x1b[6n'],
      ['DECRPM bracketed-paste mode', '\x1b[?2004$p']
    ])('does not reply to %s query', async (_label, query) => {
      createSession({ shellReadySupported: false })
      subprocess.simulateData(query)
      // Let nested xterm completion microtasks settle.
      await Promise.resolve()
      await Promise.resolve()
      expect(subprocess.written).toEqual([])
    })
  })

  describe('shell readiness gating', () => {
    // A queued renderer reply cannot unblock a shell that waits on DA1 before emitting readiness.
    it('answers DA1 once without forwarding it to a renderer', () => {
      createSession({ shellReadySupported: true })
      const onData = vi.fn((d: string) => d === '\x1b[0c' && session.write('\x1b[?1;2c'))
      session.attachClient({ onData, onExit: () => {} })

      subprocess.simulateData('\x1b[0c')

      expect(onData).toHaveBeenCalledWith('', '\x1b[0c'.length, true, '\x1b[0c'.length)
      expect(session.takePendingOutput(false)?.records).toEqual([])
      expect(session.getSnapshot()?.outputSequence).toBe('\x1b[0c'.length)
      subprocess.simulateData('\x1b]777;orca-shell-ready\x07prompt')
      vi.advanceTimersByTime(30)
      expect(subprocess.written).toEqual(['\x1b[?1;2c'])
    })

    // Precmd can precede raw mode; only startup commands wait for the flush gate.
    it('holds the startup command while user input reaches the current reader', () => {
      createSession({ shellReadySupported: true })
      expect(session.shellState).toBe('pending')

      session.writeStartupCommand('first\n')
      subprocess.simulateData('\x1b]777;orca-shell-ready\x07')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      session.write('second\n')
      expect(subprocess.written).toEqual(['second\n'])

      subprocess.simulateData('\r\nuser@host $ ')
      vi.advanceTimersByTime(30)
      expect(subprocess.written).toEqual(['second\n', 'first\n'])
    })

    it.each([
      ['color', '\x1b[?997;1n'],
      ['XTVERSION', '\x1bP>|xterm.js(6.1.0)\x1b\\']
    ])('contains live %s replies without releasing queued startup input', async (_, reply) => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 100 })
      session.writeStartupCommand('codex\n')

      session.write(reply)
      await vi.advanceTimersByTimeAsync(0)
      expect(subprocess.written).toEqual([reply])

      await vi.advanceTimersByTimeAsync(100)
      expect(subprocess.written).toEqual([reply, 'codex\n'])
    })

    it('uses the short settle path when marker and prompt bytes arrive together', () => {
      createSession({ shellReadySupported: true })
      session.writeStartupCommand('codex\n')

      subprocess.simulateData('\x1b]777;orca-shell-ready\x07\r\nuser@host $ ')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      vi.advanceTimersByTime(29)
      expect(subprocess.written).toEqual([])

      vi.advanceTimersByTime(1)
      expect(subprocess.written).toEqual(['codex\n'])
    })

    it('does not treat bytes before the marker as post-marker prompt output', () => {
      createSession({ shellReadySupported: true })
      session.writeStartupCommand('codex\n')

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
      session.writeStartupCommand('codex\n')
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

    it('exposes drained output beside an includeSnapshot take without changing records', () => {
      createSession()
      subprocess.simulateData('kept-for-durable-history\r\n')

      const taken = session.takePendingOutput(true)

      expect(taken?.records).toEqual([])
      expect(taken?.drainedRecords).toEqual([
        { kind: 'output', data: 'kept-for-durable-history\r\n' }
      ])
      expect(taken?.snapshot).toBeTruthy()
    })

    it('keeps held marker-prefix bytes during live take-with-snapshot', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 100 })
      session.writeStartupCommand('codex\n')

      subprocess.simulateData('\x1b]777;orca-shell-ready')
      const taken = session.takePendingOutput(true)
      subprocess.simulateData('\x07\r\nuser@host $ ')
      vi.advanceTimersByTime(30)

      expect(taken?.records).toEqual([])
      expect(taken?.drainedRecords).toEqual([])
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
      session.writeStartupCommand('codex\n')

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
      session.writeStartupCommand('waiting input')

      vi.advanceTimersByTime(15_000)

      expect(session.shellState).toBe('timed_out' satisfies ShellReadyState)
      expect(subprocess.written).toEqual(['waiting input'])
    })

    // Detached stdio is ignored, so readiness diagnostics must reach the daemon file log.
    it('reports the timeout to the daemon log rather than the void', () => {
      const events: { event: string; details: Record<string, unknown> }[] = []
      createSession({
        shellReadySupported: true,
        reportReadinessEvent: (event, details) => events.push({ event, details })
      })

      vi.advanceTimersByTime(15_000)

      expect(events).toHaveLength(1)
      expect(events[0]?.event).toBe('shell-ready-timeout')
      expect(events[0]?.details).toMatchObject({ sessionId: 'test-session', timeoutMs: 15_000 })
      expect(String(events[0]?.details.shell)).not.toContain('/')
    })

    // Diagnostics run before the ready transition; a throwing sink must still release queued input.
    it('still releases the barrier when the diagnostic sink throws', () => {
      createSession({
        shellReadySupported: true,
        reportReadinessEvent: () => {
          throw new Error('log sink unavailable')
        }
      })
      session.writeStartupCommand('waiting input')

      vi.advanceTimersByTime(15_000)

      expect(session.shellState).toBe('timed_out' satisfies ShellReadyState)
      expect(subprocess.written).toEqual(['waiting input'])
    })

    it('honors an injected shell-ready timeout', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 300 })
      session.writeStartupCommand('codex\n')

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
    beforeEach(() => {
      killWithDescendantSweepMock.mockImplementation((_pid: number, killRoot: () => void) => {
        killRoot()
      })
    })

    function gracefulClose(): void | Promise<void> {
      return new TerminalSessionTeardown(new Map([['test-session', session]])).killSession(
        'test-session',
        session,
        false
      )
    }

    it('kills the subprocess', () => {
      createSession()
      void gracefulClose()
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

      expect(() => gracefulClose()).toThrow('graceful kill rejected')
      expect(session.isTerminating).toBe(false)
      expect(() => gracefulClose()).not.toThrow()

      expect(attempts).toBe(2)
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

      void gracefulClose()

      await new Promise((r) => setTimeout(r, 20))
      expect(exitCodes).toEqual([0])
    })

    it('force-kills after 5s but retains ownership until subprocess exit', () => {
      createSession()
      subprocess.kill = () => {}
      const forceKillSpy = vi.spyOn(subprocess, 'forceKill')

      void gracefulClose()
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

      void gracefulClose()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(forceKillAttempts).toBe(1)
      expect(session.isTerminating).toBe(true)

      await vi.advanceTimersByTimeAsync(SESSION_FORCE_KILL_RETRY_MS)
      expect(forceKillAttempts).toBe(2)
      subprocess.simulateExit(137)
      expect(session.state).toBe('exited')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps late data and the real exit code while attributing the requested stop', () => {
      createSession()
      subprocess.kill = () => {}
      const onData = vi.fn()
      const onExit = vi.fn()
      session.attachClient({ onData, onExit })

      void gracefulClose()
      vi.advanceTimersByTime(5_000)

      subprocess.simulateData('late output')
      subprocess.simulateExit(23)

      expect(onData).toHaveBeenCalledWith('late output')
      expect(onExit).toHaveBeenCalledTimes(1)
      expect(onExit).toHaveBeenCalledWith(23, session.incarnationId, {
        kind: 'operator_close'
      })
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

  describe('snapshot', () => {
    it('parses live OSC-7 output in the session WSL distro', () => {
      createSession({ wslDistro: 'Ubuntu' })

      subprocess.simulateData('\x1b]7;file://DESKTOP-ORCA/home/jin/repo\x07')

      expect(session.getCwd()).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
    })
    it('returns a terminal snapshot', async () => {
      createSession()
      subprocess.simulateData('$ hello\r\n')
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

      session.attachClient({
        onData: (d) => received.push(d),
        onExit: () => {}
      })

      session.detachClient(token1)
      received.length = 0

      subprocess.simulateData('after detach')
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
