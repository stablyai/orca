/** Dead sessions must release both their host-map entry and headless scrollback grid. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'
import { SESSION_FORCE_KILL_RETRY_MS } from './session-termination-controller'
import type { SubprocessHandle } from './session-subprocess-handle'
import { HeadlessEmulator } from './headless-emulator'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

function createMockSubprocess(): SubprocessHandle & {
  _onDataCb: ((data: string) => void) | null
  _onExitCb: ((code: number) => void) | null
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements the subprocess contract and exposes test-only callback accessors.
  return {
    pid: 99999,
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
  } as SubprocessHandle & {
    _onDataCb: ((data: string) => void) | null
    _onExitCb: ((code: number) => void) | null
  }
}

describe('TerminalHost dead-session reaping (leak regression)', () => {
  let host: TerminalHost
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let emulatorDispose: ReturnType<typeof vi.spyOn>
  let platformDescriptor: PropertyDescriptor | undefined
  let spawnFn: TerminalHostOptions['spawnSubprocess']

  beforeEach(() => {
    // Pin POSIX for deterministic teardown; Windows tree termination has separate coverage.
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    killWithDescendantSweepMock.mockReset()
    emulatorDispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    spawnFn = vi.fn<TerminalHostOptions['spawnSubprocess']>(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    host = new TerminalHost({ spawnSubprocess: spawnFn })
  })

  afterEach(async () => {
    await host.dispose()
    emulatorDispose.mockRestore()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  function streamClient() {
    return { onData: vi.fn(), onExit: vi.fn() }
  }

  it('waits for detached descendant cleanup before killing the shell and releasing its fd', async () => {
    await host.createOrAttach({
      sessionId: 'shutdown-tree',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    let finishDescendants = (): void => {}
    killWithDescendantSweepMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDescendants = resolve
      })
    )
    let disposed = false
    const shutdown = host.dispose().then(() => {
      disposed = true
    })

    await Promise.resolve()
    expect(lastSubprocess.forceKill).not.toHaveBeenCalled()
    expect(lastSubprocess.dispose).not.toHaveBeenCalled()
    expect(disposed).toBe(false)
    finishDescendants()
    await shutdown
    expect(lastSubprocess.forceKill).toHaveBeenCalledOnce()
    expect(lastSubprocess.dispose).toHaveBeenCalledOnce()
    expect(host.listSessions()).toEqual([])
  })

  it('force-kills live subprocesses and releases PTY fds on dispose', async () => {
    await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    await host.dispose()
    // Live sessions retain the native owner until physical exit proves cleanup is safe.
    expect(lastSubprocess.forceKill).toHaveBeenCalled()
    expect(lastSubprocess.dispose).toHaveBeenCalled()
  })

  it('disposes the emulator and reaps the session when its subprocess exits', async () => {
    await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: streamClient()
    })
    expect(emulatorDispose).not.toHaveBeenCalled()
    expect(host.listSessions()).toHaveLength(1)

    lastSubprocess._onExitCb?.(0)

    expect(emulatorDispose).toHaveBeenCalledTimes(1)
    expect(host.listSessions()).toHaveLength(0)
  })

  it('does not retain dead-session emulators across many create/exit cycles', async () => {
    const CYCLES = 5
    for (let i = 0; i < CYCLES; i++) {
      await host.createOrAttach({
        sessionId: `session-${i}`,
        cols: 80,
        rows: 24,
        streamClient: streamClient()
      })
      lastSubprocess._onExitCb?.(0)
    }

    expect(emulatorDispose).toHaveBeenCalledTimes(CYCLES)
    expect(host.listSessions()).toHaveLength(0)
  })

  it('reaps a session killed immediately (forceKill path)', async () => {
    await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: streamClient()
    })
    lastSubprocess.forceKill = vi.fn()

    let releaseSweep = (): void => {}
    killWithDescendantSweepMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSweep = resolve
        })
    )
    const killed = host.kill('session-1', { immediate: true })

    expect(killWithDescendantSweepMock).toHaveBeenCalledTimes(1)
    expect(lastSubprocess.kill).not.toHaveBeenCalled()
    expect(lastSubprocess.forceKill).not.toHaveBeenCalled()
    expect(emulatorDispose).not.toHaveBeenCalled()
    releaseSweep()
    await vi.waitFor(() => expect(lastSubprocess.forceKill).toHaveBeenCalledTimes(1))
    expect(emulatorDispose).not.toHaveBeenCalled()
    expect(host.listSessions()).toHaveLength(1)
    lastSubprocess._onExitCb?.(137)
    await killed

    expect(emulatorDispose).toHaveBeenCalledTimes(1)
    expect(host.listSessions()).toHaveLength(0)
    expect(host.isKilled('session-1')).toBe(true)
  })

  it('retains a graceful-timeout session until the forced child physically exits', async () => {
    vi.useFakeTimers()
    try {
      let stubbornSubprocess: ReturnType<typeof createMockSubprocess> | undefined
      const stubbornHost = new TerminalHost({
        spawnSubprocess: () => {
          const sub = createMockSubprocess()
          // A force-kill request must not dispose the handle until exit is reported.
          sub.kill = vi.fn()
          sub.forceKill = vi.fn()
          stubbornSubprocess = sub
          return sub
        }
      })
      await stubbornHost.createOrAttach({
        sessionId: 'stubborn',
        cols: 80,
        rows: 24,
        streamClient: streamClient()
      })

      stubbornHost.kill('stubborn')
      expect(emulatorDispose).not.toHaveBeenCalled()

      // The fallback requests force-kill but still cannot claim physical exit.
      vi.advanceTimersByTime(5000)

      expect(emulatorDispose).not.toHaveBeenCalled()
      expect(stubbornHost.listSessions()).toHaveLength(1)

      stubbornSubprocess?._onExitCb?.(137)
      expect(emulatorDispose).toHaveBeenCalledTimes(1)
      expect(stubbornHost.listSessions()).toHaveLength(0)
      await stubbornHost.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('tombstones', () => {
    it('caps tombstones at limit', async () => {
      await host.dispose()
      host = new TerminalHost({ spawnSubprocess: spawnFn, maxTombstones: 3 })

      for (let i = 0; i < 5; i++) {
        await host.createOrAttach({
          sessionId: `session-${i}`,
          cols: 80,
          rows: 24,
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
        host.kill(`session-${i}`)
      }

      expect(host.isKilled('session-0')).toBe(false)
      expect(host.isKilled('session-4')).toBe(true)
    })
  })

  describe('dispose', () => {
    it('releases held shell-ready marker prefixes before final checkpoint', async () => {
      await host.dispose()
      const onFinalCheckpoint = vi.fn()
      host = new TerminalHost({
        spawnSubprocess: spawnFn,
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
        await vi.advanceTimersByTimeAsync(0)
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
      host = new TerminalHost({ spawnSubprocess: spawnFn, onSessionReaped })
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
      // Never force-kill a reaped child’s PID, which may now identify an unrelated process.
      await host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const exitedSub = lastSubprocess
      lastSubprocess._onExitCb?.(0)
      expect(host.listSessions()).toEqual([])

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
