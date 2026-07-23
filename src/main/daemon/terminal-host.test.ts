import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS,
  SESSION_FORCE_KILL_RETRY_MS,
  Session,
  type SubprocessHandle
} from './session'
import { TerminalHost } from './terminal-host'
import type { TuiAgent } from '../../shared/types'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

function createMockSubprocess(
  options: { startupCommandDeliveredInShellArgs?: boolean; shellPath?: string } = {}
): SubprocessHandle {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 99999,
    ...(options.startupCommandDeliveredInShellArgs
      ? { startupCommandDeliveredInShellArgs: true }
      : {}),
    ...(options.shellPath ? { shellPath: options.shellPath } : {}),
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      setTimeout(() => onExitCb?.(0), 5)
    }),
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    // Test helpers
    get _onDataCb() {
      return onDataCb
    },
    get _onExitCb() {
      return onExitCb
    }
  } as SubprocessHandle & { _onDataCb: typeof onDataCb; _onExitCb: typeof onExitCb }
}

type MockSpawnFn = (opts: {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  command?: string
  launchAgent?: TuiAgent
}) => SubprocessHandle

describe('TerminalHost', () => {
  let host: TerminalHost
  let spawnFn: MockSpawnFn
  let lastSubprocess: ReturnType<typeof createMockSubprocess> & {
    _onDataCb: ((data: string) => void) | null
    _onExitCb: ((code: number) => void) | null
  }

  beforeEach(() => {
    killWithDescendantSweepMock.mockReset()
    spawnFn = vi.fn(() => {
      const sub = createMockSubprocess() as ReturnType<typeof createMockSubprocess> & {
        _onDataCb: ((data: string) => void) | null
        _onExitCb: ((code: number) => void) | null
      }
      lastSubprocess = sub
      return sub
    })
    host = new TerminalHost({ spawnSubprocess: spawnFn as MockSpawnFn })
  })

  afterEach(async () => {
    await host.dispose()
  })

  describe('createOrAttach', () => {
    it('creates a new session when none exists', async () => {
      const result = await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(result.isNew).toBe(true)
      expect(result.pid).toBe(99999)
      expect(spawnFn).toHaveBeenCalledOnce()
    })

    it('attaches to existing session', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const result = await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(result.isNew).toBe(false)
      // Should not spawn a second subprocess
      expect(spawnFn).toHaveBeenCalledOnce()
    })

    it('returns snapshot when attaching to existing session', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const result = await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(result.snapshot).toBeDefined()
      expect(result.snapshot?.cols).toBe(80)
    })

    it('passes cwd, env, and trusted agent identity to spawn', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        env: { FOO: 'bar' },
        launchAgent: 'claude',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(spawnFn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          cwd: '/home/user',
          env: { FOO: 'bar' },
          launchAgent: 'claude'
        })
      )
    })

    it('queues startup commands through the session shell-ready barrier', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        command: 'echo hello',
        shellReadySupported: true,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(lastSubprocess.write).not.toHaveBeenCalled()

      // Why: the marker alone no longer flushes — the kernel can still have
      // ECHO enabled when it arrives. The flush waits for the prompt draw
      // plus a short delay so readline has switched the PTY into raw mode
      // first. Otherwise the command would be visibly double-echoed.
      lastSubprocess._onDataCb?.('\x1b]777;orca-shell-ready\x07')
      expect(lastSubprocess.write).not.toHaveBeenCalled()

      lastSubprocess._onDataCb?.('\r\nuser@host $ ')
      await new Promise((r) => setTimeout(r, 40))
      expect(lastSubprocess.write).toHaveBeenCalledWith(
        process.platform === 'win32' ? 'echo hello\r' : 'echo hello\n'
      )
    })

    it('uses the short daemon settle path when marker and prompt arrive together', async () => {
      vi.useFakeTimers()
      try {
        await host.createOrAttach({
          sessionId: 'session-1',
          cols: 80,
          rows: 24,
          command: 'echo hello',
          shellReadySupported: true,
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })

        lastSubprocess._onDataCb?.('\x1b]777;orca-shell-ready\x07\r\nuser@host $ ')
        vi.advanceTimersByTime(29)
        expect(lastSubprocess.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        expect(lastSubprocess.write).toHaveBeenCalledWith(
          process.platform === 'win32' ? 'echo hello\r' : 'echo hello\n'
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('delivers startup commands immediately when the spawned shell cannot emit the ready marker', async () => {
      spawnFn = vi.fn(() => {
        const sub = createMockSubprocess({ shellPath: '/bin/sh' }) as ReturnType<
          typeof createMockSubprocess
        > & {
          _onDataCb: ((data: string) => void) | null
          _onExitCb: ((code: number) => void) | null
        }
        lastSubprocess = sub
        return sub
      })
      await host.dispose()
      host = new TerminalHost({ spawnSubprocess: spawnFn as MockSpawnFn })

      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        command: 'echo hello',
        shellReadySupported: true,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(lastSubprocess.write).toHaveBeenCalledWith(
        process.platform === 'win32' ? 'echo hello\r' : 'echo hello\n'
      )
    })

    it('does not bracketed-paste-wrap multiline commands for a fallback shell without paste mode', async () => {
      spawnFn = vi.fn(() => {
        const sub = createMockSubprocess({ shellPath: '/bin/sh' }) as ReturnType<
          typeof createMockSubprocess
        > & {
          _onDataCb: ((data: string) => void) | null
          _onExitCb: ((code: number) => void) | null
        }
        lastSubprocess = sub
        return sub
      })
      await host.dispose()
      host = new TerminalHost({ spawnSubprocess: spawnFn as MockSpawnFn })

      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        command: 'claude "line one\nline two"',
        shellReadySupported: true,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const written = (lastSubprocess.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      expect(written).not.toContain('\x1b[200~')
      expect(written).toContain('line one\nline two')
    })

    it('keeps the shell-ready barrier when the spawned shell supports the marker', async () => {
      spawnFn = vi.fn(() => {
        const sub = createMockSubprocess({ shellPath: '/bin/bash' }) as ReturnType<
          typeof createMockSubprocess
        > & {
          _onDataCb: ((data: string) => void) | null
          _onExitCb: ((code: number) => void) | null
        }
        lastSubprocess = sub
        return sub
      })
      await host.dispose()
      host = new TerminalHost({ spawnSubprocess: spawnFn as MockSpawnFn })

      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        command: 'echo hello',
        shellReadySupported: true,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(lastSubprocess.write).not.toHaveBeenCalled()
    })

    it('does not write startup commands already embedded in shell args', async () => {
      spawnFn = vi.fn(() => {
        const sub = createMockSubprocess({
          startupCommandDeliveredInShellArgs: true
        }) as ReturnType<typeof createMockSubprocess> & {
          _onDataCb: ((data: string) => void) | null
          _onExitCb: ((code: number) => void) | null
        }
        lastSubprocess = sub
        return sub
      })
      await host.dispose()
      host = new TerminalHost({ spawnSubprocess: spawnFn as MockSpawnFn })

      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        command: 'codex --no-alt-screen',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(lastSubprocess.write).not.toHaveBeenCalled()
    })
  })

  describe('write', () => {
    it('forwards write to the session', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      host.write('session-1', 'hello')
      expect(lastSubprocess.write).toHaveBeenCalledWith('hello')
    })

    it('throws for non-existent session', () => {
      expect(() => host.write('missing', 'data')).toThrow('Session not found')
    })
  })

  describe('resize', () => {
    it('normalizes invalid initial dimensions before spawning a session', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 0,
        rows: -1,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(spawnFn).toHaveBeenCalledWith(expect.objectContaining({ cols: 80, rows: 24 }))
      expect(host.listSessions()[0]).toMatchObject({ cols: 80, rows: 24 })
    })

    it('forwards resize to the session', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      host.resize('session-1', 120, 40)
      expect(lastSubprocess.resize).toHaveBeenCalledWith(120, 40)
    })

    it('ignores transient zero-size resize events', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      host.resize('session-1', 0, 0)

      expect(lastSubprocess.resize).not.toHaveBeenCalled()
      expect(host.listSessions()[0]).toMatchObject({ cols: 80, rows: 24 })
    })
  })

  describe('kill', () => {
    it('kills the session and tombstones it', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      host.kill('session-1')
      expect(lastSubprocess.kill).toHaveBeenCalled()
      expect(host.isKilled('session-1')).toBe(true)
    })

    it('does not tombstone a session when graceful kill admission fails', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      lastSubprocess.kill = vi.fn(() => {
        throw new Error('signal rejected')
      })

      expect(() => host.kill('session-1')).toThrow('signal rejected')
      expect(host.isKilled('session-1')).toBe(false)
      await expect(
        host.createOrAttach({
          sessionId: 'session-1',
          cols: 80,
          rows: 24,
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
      ).resolves.toMatchObject({ isNew: false })
    })

    it('force-kills immediately when requested', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      lastSubprocess.forceKill = vi.fn()

      const killed = host.kill('session-1', { immediate: true })

      expect(lastSubprocess.kill).not.toHaveBeenCalled()
      expect(lastSubprocess.forceKill).toHaveBeenCalled()
      expect(killWithDescendantSweepMock).not.toHaveBeenCalled()
      expect(lastSubprocess.dispose).not.toHaveBeenCalled()
      expect(host.listSessions()).toHaveLength(1)

      lastSubprocess._onExitCb?.(137)
      await killed

      expect(lastSubprocess.dispose).toHaveBeenCalled()
      expect(host.listSessions()).toHaveLength(0)
      expect(host.isKilled('session-1')).toBe(true)
    })

    it('escalates an already-graceful termination and joins its physical exit', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      lastSubprocess.forceKill = vi.fn()

      await host.kill('session-1')
      const immediate = host.kill('session-1', { immediate: true })
      let settled = false
      void immediate.then(() => {
        settled = true
      })
      await Promise.resolve()

      expect(lastSubprocess.kill).toHaveBeenCalledTimes(1)
      expect(lastSubprocess.forceKill).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)
      expect(host.listSessions()).toHaveLength(1)

      lastSubprocess._onExitCb?.(137)
      await immediate
      expect(host.listSessions()).toHaveLength(0)
    })

    it('retains an immediate-kill session when physical exit times out', async () => {
      vi.useFakeTimers()
      try {
        await host.createOrAttach({
          sessionId: 'session-1',
          cols: 80,
          rows: 24,
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
        lastSubprocess.forceKill = vi.fn()

        const killed = host.kill('session-1', { immediate: true })
        const rejected = expect(killed).rejects.toThrow('Timed out waiting for PTY process exit')
        await vi.advanceTimersByTimeAsync(IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS)
        await rejected

        expect(lastSubprocess.forceKill).toHaveBeenCalledTimes(1)
        expect(lastSubprocess.dispose).not.toHaveBeenCalled()
        expect(host.listSessions()).toHaveLength(1)
        await expect(
          host.createOrAttach({
            sessionId: 'session-1',
            cols: 80,
            rows: 24,
            streamClient: { onData: vi.fn(), onExit: vi.fn() }
          })
        ).rejects.toThrow('Session not found')

        lastSubprocess._onExitCb?.(137)
        expect(host.listSessions()).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('throws for non-existent session', () => {
      expect(() => host.kill('missing')).toThrow('Session not found')
    })

    it('agent immediate kill routes through the descendant sweep and defers the force-kill to it', async () => {
      await host.createOrAttach({
        sessionId: 'agent-1',
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      lastSubprocess.forceKill = vi.fn()

      const killing = host.kill('agent-1', { immediate: true })

      // Why order matters: force-killing first would let orphans reparent to
      // pid 1 and escape the sweep's ppid walk entirely.
      expect(killWithDescendantSweepMock).toHaveBeenCalledWith(
        99999,
        expect.any(Function),
        expect.objectContaining({ ownsRoot: expect.any(Function) })
      )
      expect(lastSubprocess.forceKill).not.toHaveBeenCalled()
      expect(host.isKilled('agent-1')).toBe(true)

      const finish = killWithDescendantSweepMock.mock.calls[0][1] as () => void
      finish()
      expect(lastSubprocess.forceKill).toHaveBeenCalled()
      expect(lastSubprocess.dispose).not.toHaveBeenCalled()

      lastSubprocess._onExitCb?.(137)
      await killing
      expect(lastSubprocess.dispose).toHaveBeenCalled()
    })

    it('rejects reattach while an agent immediate-kill snapshot is pending', async () => {
      let finishSweep!: () => void
      killWithDescendantSweepMock.mockImplementation(
        (_pid: number, finish: () => void) =>
          new Promise<void>((resolve) => {
            finishSweep = () => {
              finish()
              resolve()
            }
          })
      )
      await host.createOrAttach({
        sessionId: 'agent-reattach',
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const killing = host.kill('agent-reattach', { immediate: true })
      await expect(
        host.createOrAttach({
          sessionId: 'agent-reattach',
          cols: 80,
          rows: 24,
          launchAgent: 'claude',
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
      ).rejects.toThrow('Session not found')
      expect(lastSubprocess.forceKill).not.toHaveBeenCalled()

      finishSweep()
      lastSubprocess._onExitCb?.(137)
      await killing
      expect(lastSubprocess.forceKill).toHaveBeenCalledOnce()
    })

    it('coalesces duplicate immediate kill while descendant capture is pending', async () => {
      const sweep = new Promise<void>(() => {})
      killWithDescendantSweepMock.mockReturnValue(sweep)
      await host.createOrAttach({
        sessionId: 'agent-duplicate-kill',
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const first = host.kill('agent-duplicate-kill', { immediate: true })
      // The root can exit while the descendant scan is pending. Duplicate RPCs
      // still own the original completion even after the session was reaped.
      lastSubprocess._onExitCb?.(0)
      const second = host.kill('agent-duplicate-kill', { immediate: true })

      expect(killWithDescendantSweepMock).toHaveBeenCalledOnce()
      expect(second).toBe(first)
      expect(lastSubprocess.forceKill).not.toHaveBeenCalled()
    })

    it('keeps a naturally-exited id reserved until teardown finishes without re-killing its pid', async () => {
      let completeSweep!: () => void
      killWithDescendantSweepMock.mockImplementation(
        (_pid: number, finish: () => void) =>
          new Promise<void>((resolve) => {
            completeSweep = () => {
              finish()
              resolve()
            }
          })
      )
      await host.createOrAttach({
        sessionId: 'agent-natural-exit',
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      const retiredSubprocess = lastSubprocess

      const killing = host.kill('agent-natural-exit', { immediate: true })
      retiredSubprocess._onExitCb?.(0)
      await expect(
        host.createOrAttach({
          sessionId: 'agent-natural-exit',
          cols: 80,
          rows: 24,
          launchAgent: 'claude',
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
      ).rejects.toThrow('Session not found')

      completeSweep()
      await killing
      expect(retiredSubprocess.forceKill).not.toHaveBeenCalled()

      await expect(
        host.createOrAttach({
          sessionId: 'agent-natural-exit',
          cols: 80,
          rows: 24,
          launchAgent: 'claude',
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
      ).resolves.toEqual(expect.objectContaining({ isNew: true }))
      expect(spawnFn).toHaveBeenCalledTimes(2)
    })

    it('upgrades a pending graceful agent teardown when immediate kill arrives', async () => {
      let completeSweep!: () => void
      killWithDescendantSweepMock.mockImplementation(
        (_pid: number, finish: () => void) =>
          new Promise<void>((resolve) => {
            completeSweep = () => {
              finish()
              resolve()
            }
          })
      )
      await host.createOrAttach({
        sessionId: 'agent-upgrade-kill',
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const graceful = host.kill('agent-upgrade-kill')
      const immediate = host.kill('agent-upgrade-kill', { immediate: true })
      expect(immediate).toBe(graceful)
      expect(lastSubprocess.kill).not.toHaveBeenCalled()
      expect(lastSubprocess.forceKill).not.toHaveBeenCalled()

      completeSweep()
      lastSubprocess._onExitCb?.(137)
      await Promise.all([graceful, immediate])
      expect(lastSubprocess.kill).not.toHaveBeenCalled()
      expect(lastSubprocess.forceKill).toHaveBeenCalledOnce()
      expect(lastSubprocess.dispose).toHaveBeenCalledOnce()
    })

    it('force-kills when immediate teardown follows a completed graceful snapshot', async () => {
      killWithDescendantSweepMock.mockImplementation(async (_pid: number, finish: () => void) =>
        finish()
      )
      await host.createOrAttach({
        sessionId: 'agent-post-snapshot-upgrade',
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      await host.kill('agent-post-snapshot-upgrade')
      expect(lastSubprocess.kill).toHaveBeenCalledOnce()
      expect(lastSubprocess.forceKill).not.toHaveBeenCalled()
      lastSubprocess.forceKill = vi.fn()

      const immediate = host.kill('agent-post-snapshot-upgrade', { immediate: true })
      expect(lastSubprocess.forceKill).toHaveBeenCalledOnce()
      expect(lastSubprocess.dispose).not.toHaveBeenCalled()

      lastSubprocess._onExitCb?.(137)
      await immediate
      expect(lastSubprocess.dispose).toHaveBeenCalledOnce()
    })
  })

  describe('signal', () => {
    it('sends signal without entering kill state', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      host.signal('session-1', 'SIGINT')
      expect(lastSubprocess.signal).toHaveBeenCalledWith('SIGINT')
      expect(host.isKilled('session-1')).toBe(false)
    })
  })

  describe('listSessions', () => {
    it('returns empty list initially', () => {
      expect(host.listSessions()).toEqual([])
    })

    it('lists created sessions', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      await host.createOrAttach({
        sessionId: 'session-2',
        cols: 120,
        rows: 40,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const sessions = host.listSessions()
      expect(sessions).toHaveLength(2)
      expect(sessions.map((s) => s.sessionId).sort()).toEqual(['session-1', 'session-2'])
    })

    it('uses applied size without serializing terminal snapshots', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      host.resize('session-1', 132, 43)

      const getSnapshot = vi.spyOn(Session.prototype, 'getSnapshot')

      expect(host.listSessions()[0]).toMatchObject({
        sessionId: 'session-1',
        cols: 132,
        rows: 43
      })
      expect(getSnapshot).not.toHaveBeenCalled()
    })
  })

  describe('detach', () => {
    it('detaches a client from a session', async () => {
      const onData = vi.fn()
      const result = await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData, onExit: vi.fn() }
      })

      host.detach('session-1', result.attachToken)

      // Data after detach should not be received
      lastSubprocess._onDataCb?.('after detach')
      expect(onData).not.toHaveBeenCalled()
    })
  })

  describe('tombstones', () => {
    it('caps tombstones at limit', async () => {
      await host.dispose()
      host = new TerminalHost({ spawnSubprocess: spawnFn as MockSpawnFn, maxTombstones: 3 })

      for (let i = 0; i < 5; i++) {
        await host.createOrAttach({
          sessionId: `session-${i}`,
          cols: 80,
          rows: 24,
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
        host.kill(`session-${i}`)
      }

      // Oldest tombstones should be evicted
      expect(host.isKilled('session-0')).toBe(false)
      expect(host.isKilled('session-4')).toBe(true)
    })
  })

  describe('dispose', () => {
    it('force-kills live subprocesses and releases PTY fds on dispose', async () => {
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      await host.dispose()
      // Why: live sessions retain the native owner until force-kill is accepted
      // and physical exit proves the child can no longer hold the ptmx fd.
      // Exited sessions take the disposeSubprocess() path instead (see the test
      // below). See docs/fix-pty-fd-leak.md.
      expect(lastSubprocess.forceKill).toHaveBeenCalled()
      expect(lastSubprocess.dispose).toHaveBeenCalled()
    })

    it('releases held shell-ready marker prefixes before final checkpoint', async () => {
      await host.dispose()
      const onFinalCheckpoint = vi.fn()
      host = new TerminalHost({
        spawnSubprocess: spawnFn as MockSpawnFn,
        onFinalCheckpoint
      })
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        shellReadySupported: true,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSubprocess._onDataCb?.('\x1b]777;orca-shell-ready')
      await host.dispose()

      expect(onFinalCheckpoint).toHaveBeenCalledWith('session-1', expect.any(Object), [
        { kind: 'output', data: '\x1b]777;orca-shell-ready' }
      ])
    })

    it('fences creation and retries a rejected force kill before dropping ownership', async () => {
      vi.useFakeTimers()
      try {
        await host.createOrAttach({
          sessionId: 'session-1',
          cols: 80,
          rows: 24,
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
        let attempts = 0
        const forceKill = vi.fn(() => {
          attempts++
          if (attempts === 1) {
            throw new Error('transient daemon dispose kill failure')
          }
          lastSubprocess._onExitCb?.(137)
        })
        lastSubprocess.forceKill = forceKill

        const dispose = host.dispose()
        expect(forceKill).toHaveBeenCalledTimes(1)
        expect(host.dispose()).toBe(dispose)
        await expect(
          host.createOrAttach({
            sessionId: 'late-session',
            cols: 80,
            rows: 24,
            streamClient: { onData: vi.fn(), onExit: vi.fn() }
          })
        ).rejects.toThrow('Terminal host is shutting down')

        await vi.advanceTimersByTimeAsync(SESSION_FORCE_KILL_RETRY_MS)
        await dispose
        expect(forceKill).toHaveBeenCalledTimes(2)
        expect(lastSubprocess.dispose).toHaveBeenCalled()
        expect(host.listSessions()).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not list exited sessions', async () => {
      const onSessionReaped = vi.fn()
      host = new TerminalHost({ spawnSubprocess: spawnFn as MockSpawnFn, onSessionReaped })
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSubprocess._onExitCb?.(0)
      expect(host.listSessions()).toEqual([])
      expect(onSessionReaped).toHaveBeenCalledWith('session-1')
    })

    it('never force-kills an exited session (recycled-pid SIGKILL safety)', async () => {
      // Why: after a session's subprocess has exited (onExit fired), proc.pid
      // refers to a reaped child whose pid may have been recycled. Force-killing
      // it would process.kill(recycled_pid, 'SIGKILL') — killing a stranger.
      // The exit now reaps the session via session.dispose(), which skips
      // forceKill once _state==='exited' (only the fd is released). host.dispose
      // then only ever sees live sessions.
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      // Natural exit reaps session-1 synchronously: its subprocess fd is
      // released (dispose) but it is never force-killed, and it is dropped from
      // the map (so it is not listed and not touched by host.dispose below).
      const exitedSub = lastSubprocess
      lastSubprocess._onExitCb?.(0)
      expect(host.listSessions()).toEqual([])

      // A second, live session remains in the map for host.dispose to reap.
      await host.createOrAttach({
        sessionId: 'session-2',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      const liveSub = lastSubprocess

      await host.dispose()

      expect(exitedSub.forceKill).not.toHaveBeenCalled()
      expect(exitedSub.dispose).toHaveBeenCalled()
      expect(liveSub.forceKill).toHaveBeenCalled()
      expect(liveSub.dispose).toHaveBeenCalled()
    })
  })
})
