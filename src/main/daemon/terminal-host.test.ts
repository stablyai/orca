import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import {
  IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS,
  SESSION_FORCE_KILL_RETRY_MS
} from './session-termination-controller'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'
import type { TuiAgent } from '../../shared/tui-agent'
import type * as PtyDescendantTermination from '../pty-descendant-termination'

const { killWithDescendantSweepMock, readProcessTableMock } = vi.hoisted(() => ({
  killWithDescendantSweepMock: vi.fn(),
  readProcessTableMock: vi.fn()
}))

const rootRow = { pid: 99999, ppid: 1, pgid: 99999, startedAt: 'captured' }

const processTable = (rows: (typeof rootRow)[] = [rootRow]) => ({ rows, capturedAtMs: Date.now() })

function queueExitedTreeObservation(): void {
  readProcessTableMock
    .mockResolvedValueOnce(processTable())
    .mockResolvedValueOnce(processTable([]))
    .mockResolvedValueOnce(processTable([]))
}

function deferDescendantSweep(signalRootBeforeRelease = false): () => void {
  let finishSweep!: () => void
  killWithDescendantSweepMock.mockImplementation(
    (_pid: number, finish: () => void) =>
      new Promise<void>((resolve) => {
        if (signalRootBeforeRelease) {
          finish()
        }
        finishSweep = () => {
          if (!signalRootBeforeRelease) {
            finish()
          }
          resolve()
        }
      })
  )
  return () => finishSweep()
}
vi.mock('../pty-descendant-termination', async (importOriginal) => ({
  ...(await importOriginal<typeof PtyDescendantTermination>()),
  DESCENDANT_KILL_GRACE_MS: 0,
  killWithDescendantSweep: killWithDescendantSweepMock,
  readProcessTable: readProcessTableMock
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
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    // Pin POSIX so plain-shell teardown is deterministic across host OSes (matches linux CI);
    // the Windows taskkill /T /F tree-kill path is covered in terminal-session-teardown.test.ts.
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    killWithDescendantSweepMock.mockReset()
    readProcessTableMock.mockReset()
    readProcessTableMock.mockImplementation(async () => processTable())
    killWithDescendantSweepMock.mockImplementation(async (_pid: number, signalRoot: () => void) =>
      signalRoot()
    )
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
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('rejects missing strict inspection', () =>
    expect(() => host.inspectProcess('missing-session')).toThrow('not found'))

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
    async function createSession(sessionId = 'session-1'): Promise<void> {
      await host.createOrAttach({
        sessionId,
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    }

    it('kills the session and records the stop request', async () => {
      await createSession()
      queueExitedTreeObservation()

      const killing = host.kill('session-1')

      expect(host.isKilled('session-1')).toBe(true)
      const receipt = await killing
      expect(receipt).toMatchObject({ verdict: 'exited', processTreeVerified: true })
    })

    it('does not retain a tombstone when graceful kill admission fails', async () => {
      await createSession()
      lastSubprocess.kill = vi.fn(() => {
        throw new Error('signal rejected')
      })

      await expect(host.kill('session-1')).rejects.toThrow('signal rejected')
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

    it('returns the execution-owner receipt for the exact incarnation', async () => {
      await createSession()
      const [{ incarnationId }] = host.listSessions()
      queueExitedTreeObservation()

      const receipt = await host.kill('session-1', {
        immediate: true,
        expectedIncarnationId: incarnationId
      })

      expect(receipt).toMatchObject({
        executionHostId: 'local',
        ptyId: 'session-1',
        ptyIncarnation: incarnationId,
        verdict: 'exited',
        processTreeVerified: true
      })
    })

    it('replays the immutable receipt for the same incarnation', async () => {
      await createSession()
      const [{ incarnationId }] = host.listSessions()
      queueExitedTreeObservation()

      const first = await host.kill('session-1', {
        immediate: true,
        expectedIncarnationId: incarnationId
      })
      const retry = await host.kill('session-1', {
        immediate: true,
        expectedIncarnationId: incarnationId
      })

      expect(retry).toBe(first)
      expect(lastSubprocess.forceKill).toHaveBeenCalledOnce()
    })

    it('rejects a stop request for a different incarnation before signaling', async () => {
      await createSession()

      await expect(
        host.kill('session-1', {
          immediate: true,
          expectedIncarnationId: '22222222-2222-4222-8222-222222222222'
        })
      ).rejects.toThrow('pty_stop_receipt_identity_mismatch')
      expect(lastSubprocess.kill).not.toHaveBeenCalled()
      expect(lastSubprocess.forceKill).not.toHaveBeenCalled()
    })

    it('returns live without treating physical root state as process-tree proof', async () => {
      await createSession()
      lastSubprocess.kill = vi.fn()

      const receipt = await host.kill('session-1')

      expect(receipt).toMatchObject({ verdict: 'live', processTreeVerified: false })
      expect(host.listSessions()).toHaveLength(1)
    })

    it('defers a respawn until teardown releases the previous incarnation', async () => {
      queueExitedTreeObservation()
      const finishSweep = deferDescendantSweep()
      await createSession('agent-reattach')
      const retiredSubprocess = lastSubprocess

      const killing = host.kill('agent-reattach', { immediate: true })
      await vi.waitFor(() => expect(killWithDescendantSweepMock).toHaveBeenCalledOnce())
      const respawn = host.createOrAttach({
        sessionId: 'agent-reattach',
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      expect(spawnFn).toHaveBeenCalledOnce()
      expect(retiredSubprocess.forceKill).not.toHaveBeenCalled()

      finishSweep()
      await expect(killing).resolves.toMatchObject({ verdict: 'exited' })
      await expect(respawn).resolves.toMatchObject({ isNew: true })
      expect(retiredSubprocess.forceKill).toHaveBeenCalledOnce()
    })

    it('coalesces duplicate immediate kills while descendant capture is pending', async () => {
      queueExitedTreeObservation()
      const finishSweep = deferDescendantSweep()
      await createSession('agent-duplicate-kill')

      const first = host.kill('agent-duplicate-kill', { immediate: true })
      await vi.waitFor(() => expect(killWithDescendantSweepMock).toHaveBeenCalledOnce())
      lastSubprocess._onExitCb?.(0)
      const second = host.kill('agent-duplicate-kill', { immediate: true })

      expect(second).toBe(first)
      expect(killWithDescendantSweepMock).toHaveBeenCalledOnce()
      expect(lastSubprocess.forceKill).not.toHaveBeenCalled()
      finishSweep()
      await expect(first).resolves.toMatchObject({ verdict: 'exited' })
    })

    it('reserves a naturally exited id until teardown finishes without re-killing a reused PID', async () => {
      queueExitedTreeObservation()
      const finishSweep = deferDescendantSweep()
      await createSession('agent-natural-exit')
      const retiredSubprocess = lastSubprocess

      const killing = host.kill('agent-natural-exit', { immediate: true })
      await vi.waitFor(() => expect(killWithDescendantSweepMock).toHaveBeenCalledOnce())
      retiredSubprocess._onExitCb?.(0)
      const respawn = host.createOrAttach({
        sessionId: 'agent-natural-exit',
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      expect(spawnFn).toHaveBeenCalledOnce()

      finishSweep()
      await killing
      expect(retiredSubprocess.forceKill).not.toHaveBeenCalled()
      await expect(respawn).resolves.toMatchObject({ isNew: true })
      expect(spawnFn).toHaveBeenCalledTimes(2)
    })

    it('upgrades a pending graceful teardown when immediate kill arrives', async () => {
      queueExitedTreeObservation()
      const finishSweep = deferDescendantSweep()
      await createSession('agent-upgrade-kill')

      const graceful = host.kill('agent-upgrade-kill')
      await vi.waitFor(() => expect(killWithDescendantSweepMock).toHaveBeenCalledOnce())
      const immediate = host.kill('agent-upgrade-kill', { immediate: true })

      expect(immediate).toBe(graceful)
      expect(lastSubprocess.kill).not.toHaveBeenCalled()
      expect(lastSubprocess.forceKill).not.toHaveBeenCalled()
      finishSweep()
      await expect(immediate).resolves.toMatchObject({ verdict: 'exited' })
      expect(lastSubprocess.forceKill).toHaveBeenCalledOnce()
    })

    it('escalates an already-signaled graceful teardown and joins physical exit', async () => {
      queueExitedTreeObservation()
      const finishSweep = deferDescendantSweep(true)
      await createSession('already-graceful')
      Object.assign(lastSubprocess, { kill: vi.fn(), forceKill: vi.fn() })
      const graceful = host.kill('already-graceful')
      await vi.waitFor(() => expect(lastSubprocess.kill).toHaveBeenCalledOnce())
      const immediate = host.kill('already-graceful', { immediate: true })
      expect(immediate).toBe(graceful)
      expect(lastSubprocess.forceKill).toHaveBeenCalledOnce()
      finishSweep()
      expect(lastSubprocess.dispose).not.toHaveBeenCalled()
      lastSubprocess._onExitCb?.(137)
      await expect(immediate).resolves.toMatchObject({ verdict: 'exited' })
      expect(host.listSessions()).toHaveLength(0)
    })

    it('force-kills after a completed graceful snapshot and returns upgraded proof', async () => {
      await createSession('completed-graceful')
      lastSubprocess.kill = vi.fn()
      const gracefulReceipt = await host.kill('completed-graceful')
      expect(gracefulReceipt).toMatchObject({ verdict: 'live', processTreeVerified: false })
      queueExitedTreeObservation()
      lastSubprocess.forceKill = vi.fn()
      const immediate = host.kill('completed-graceful', { immediate: true })
      await vi.waitFor(() => expect(lastSubprocess.forceKill).toHaveBeenCalledOnce())
      expect(lastSubprocess.dispose).not.toHaveBeenCalled()
      lastSubprocess._onExitCb?.(137)
      const receipt = await immediate
      expect(receipt).toMatchObject({ verdict: 'exited', processTreeVerified: true })
      expect(lastSubprocess.dispose).toHaveBeenCalledOnce()
    })

    it('retains ownership and reports live when native physical exit times out', async () => {
      vi.useFakeTimers()
      try {
        await createSession('session-timeout')
        lastSubprocess.forceKill = vi.fn()

        const killing = host.kill('session-timeout', { immediate: true })
        await vi.advanceTimersByTimeAsync(IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS + 100)
        const receipt = await killing

        expect(receipt).toMatchObject({ verdict: 'live', processTreeVerified: false })
        expect(lastSubprocess.forceKill).toHaveBeenCalledOnce()
        expect(lastSubprocess.dispose).not.toHaveBeenCalled()
        expect(host.listSessions()).toHaveLength(1)
        await expect(
          host.createOrAttach({
            sessionId: 'session-timeout',
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

    it('captures descendants before signaling the agent root', async () => {
      queueExitedTreeObservation()
      const finishSweep = deferDescendantSweep()
      await createSession('agent-sweep-order')

      const killing = host.kill('agent-sweep-order', { immediate: true })
      await vi.waitFor(() => expect(killWithDescendantSweepMock).toHaveBeenCalledOnce())

      expect(killWithDescendantSweepMock).toHaveBeenCalledWith(
        99999,
        expect.any(Function),
        expect.objectContaining({ ownsRoot: expect.any(Function) })
      )
      expect(lastSubprocess.forceKill).not.toHaveBeenCalled()
      finishSweep()
      expect(lastSubprocess.forceKill).toHaveBeenCalledOnce()
      await expect(killing).resolves.toMatchObject({ verdict: 'exited' })
    })

    it('throws for a non-existent session without inventing a receipt', () => {
      expect(() => host.kill('missing')).toThrow('Session not found')
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
