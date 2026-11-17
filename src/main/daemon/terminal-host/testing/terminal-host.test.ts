import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS } from '../../sessions/immediate-kill-reply-budget'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { TerminalHost } from '../terminal-host'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../../../pty/process-retirement/pty-descendant-termination', () => ({
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
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
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
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    // Pin POSIX for deterministic teardown; Windows tree termination has separate coverage.
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    killWithDescendantSweepMock.mockReset()
    spawnFn = vi.fn(() => {
      const sub = createMockSubprocess() as ReturnType<typeof createMockSubprocess> & {
        _onDataCb: ((data: string) => void) | null
        _onExitCb: ((code: number) => void) | null
      }
      lastSubprocess = sub
      return sub
    })
    host = new TerminalHost({ spawnSubprocess: spawnFn })
  })

  afterEach(async () => {
    killWithDescendantSweepMock.mockReset()
    await host.dispose()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  describe('createOrAttach', () => {
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

      // Delay post-marker input until prompt output and raw-mode setup prevent cooked echo.
      lastSubprocess._onDataCb?.('\x1b]777;orca-shell-ready\x07')
      expect(lastSubprocess.write).not.toHaveBeenCalled()

      lastSubprocess._onDataCb?.('\r\nuser@host $ ')
      await new Promise((r) => setTimeout(r, 40))
      expect(lastSubprocess.write).toHaveBeenCalledWith('echo hello\r')
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
      host = new TerminalHost({ spawnSubprocess: spawnFn })

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

  describe('kill', () => {
    function sweepThenSignalRoot(): void {
      killWithDescendantSweepMock.mockImplementation(async (_pid: number, killRoot: () => void) => {
        killRoot()
      })
    }

    it('keeps a session attachable when its graceful kill signal is rejected', async () => {
      sweepThenSignalRoot()
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      lastSubprocess.kill = vi.fn(() => {
        throw new Error('signal rejected')
      })

      await expect(host.kill('session-1')).rejects.toThrow('signal rejected')
      await expect(
        host.createOrAttach({
          sessionId: 'session-1',
          cols: 80,
          rows: 24,
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
      ).resolves.toMatchObject({ isNew: false })
    })

    it('escalates an already-graceful termination and joins its physical exit', async () => {
      sweepThenSignalRoot()
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
        // An unkillable child keeps its ID reserved across recreation attempts.
        const recreate = host.createOrAttach({
          sessionId: 'session-1',
          cols: 80,
          rows: 24,
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
        const refused = expect(recreate).rejects.toThrow('Session not found')
        await vi.advanceTimersByTimeAsync(IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS)
        await refused

        lastSubprocess._onExitCb?.(137)
        expect(host.listSessions()).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('defers a respawn until the agent immediate-kill snapshot completes', async () => {
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

      const retiredSubprocess = lastSubprocess
      const killing = host.kill('agent-reattach', { immediate: true })
      let respawned = false
      const respawn = host
        .createOrAttach({
          sessionId: 'agent-reattach',
          cols: 80,
          rows: 24,
          launchAgent: 'claude',
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
        .then((result) => {
          respawned = true
          return result
        })
      await Promise.resolve()
      await Promise.resolve()

      // Publishing before capture ends would attach to a session teardown still owns.
      expect(respawned).toBe(false)
      expect(spawnFn).toHaveBeenCalledTimes(1)
      expect(retiredSubprocess.forceKill).not.toHaveBeenCalled()

      finishSweep()
      retiredSubprocess._onExitCb?.(137)
      await killing
      await expect(respawn).resolves.toMatchObject({ isNew: true })
      expect(retiredSubprocess.forceKill).toHaveBeenCalledOnce()
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
      let respawned = false
      const respawn = host
        .createOrAttach({
          sessionId: 'agent-natural-exit',
          cols: 80,
          rows: 24,
          launchAgent: 'claude',
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
        .then((result) => {
          respawned = true
          return result
        })
      await Promise.resolve()
      await Promise.resolve()

      expect(respawned).toBe(false)
      expect(spawnFn).toHaveBeenCalledTimes(1)

      completeSweep()
      await killing
      expect(retiredSubprocess.forceKill).not.toHaveBeenCalled()

      await expect(respawn).resolves.toEqual(expect.objectContaining({ isNew: true }))
      expect(spawnFn).toHaveBeenCalledTimes(2)
    })
  })

  // The activation gate claims sleeping records by this key, so reattaching must not rewrite it.
})
