import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  writeFileSyncMock,
  forkMock,
  checkDaemonHealthMock,
  unlinkOwnedDaemonPidFileMock,
  daemonClientMock,
  spawnerInstances,
  importFresh,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

vi.mock('fs', () => moduleFactories.fs())
vi.mock('child_process', async (importOriginal) =>
  moduleFactories.childProcess(await importOriginal<Record<string, unknown>>())
)
vi.mock('net', () => moduleFactories.net())
vi.mock('./daemon-health', () => moduleFactories.daemonHealth())
vi.mock('./daemon-pid-identity', () => moduleFactories.daemonPidIdentity())
vi.mock('./daemon-tcc-attribution', () => moduleFactories.daemonTccAttribution())
vi.mock('./daemon-bundle-staleness', () => moduleFactories.daemonBundleStaleness())
vi.mock('./daemon-stale-kill', () => moduleFactories.daemonStaleKill())
vi.mock('./daemon-process-start-time', () => moduleFactories.daemonProcessStartTime())
vi.mock('./daemon-pid-file-parse', () => moduleFactories.daemonPidFileParse())
vi.mock('./client', () => moduleFactories.client())
vi.mock('./daemon-lifecycle-event', () => moduleFactories.daemonLifecycleEvent())
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())

describe('daemon-init: runRestartDaemon (7-step sequence)', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    [
      'changed endpoint identity',
      () => ({
        getDaemonIdentity: vi.fn(() => ({
          pid: 999,
          startedAtMs: 900_000,
          launchNonce: 'stale-launch'
        }))
      })
    ],
    ['missing endpoint identity reader', () => ({})]
  ])('rejects and reaps a child with %s before adoption', async (_case, identityMethods) => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()
    function basicClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        ensureConnectedWithin: vi.fn(async () => {}),
        request: vi.fn(async () => ({ sessions: [] })),
        disconnect: vi.fn()
      }
    }
    daemonClientMock.mockImplementationOnce(basicClient)
    daemonClientMock.mockImplementationOnce(basicClient)
    daemonClientMock.mockImplementationOnce(function postReadyClient() {
      return {
        ...basicClient(),
        ...identityMethods()
      }
    })
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const child = {
      pid: 12345,
      connected: true,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      on(event: string, callback: (arg?: unknown) => void) {
        handlers[event]?.push(callback)
        if (event === 'message') {
          queueMicrotask(() => callback({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      off(event: string, callback: (arg?: unknown) => void) {
        handlers[event] = handlers[event]?.filter((handler) => handler !== callback) ?? []
        return this
      },
      kill: vi.fn(() => true),
      disconnect: vi.fn(() => {
        child.connected = false
      }),
      unref: vi.fn()
    }
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      queueMicrotask(() => {
        child.exitCode = 0
        for (const callback of handlers.exit.slice()) {
          callback(0)
        }
      })
      return true
    })
    forkMock.mockReturnValueOnce(child)
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ shutdown(): Promise<void> }>

    try {
      await expect(
        launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'launch-new')
      ).rejects.toThrow('Daemon endpoint ownership changed during startup')

      expect(kill).toHaveBeenCalledWith(12345, 'SIGTERM')
      expect(unlinkOwnedDaemonPidFileMock).toHaveBeenCalledWith(
        '/fake/daemon.pid',
        12345,
        'launch-new'
      )
    } finally {
      kill.mockRestore()
    }
  })

  it('keeps a live PID record after adoption failure and removes it on exact child exit', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()
    const adoptionDisconnects: ReturnType<typeof vi.fn>[] = []
    function MockFailingAdoptionClient() {
      const disconnect = vi.fn()
      adoptionDisconnects.push(disconnect)
      return {
        ensureConnected: vi.fn(async () => {
          throw new Error('adoption unavailable')
        }),
        ensureConnectedWithin: vi.fn(async () => {
          throw new Error('adoption unavailable')
        }),
        request: vi.fn(),
        disconnect
      }
    }
    for (let index = 0; index < 3; index++) {
      daemonClientMock.mockImplementationOnce(MockFailingAdoptionClient)
    }
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const child = {
      pid: 12345,
      connected: true,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      on(event: string, callback: (arg?: unknown) => void) {
        handlers[event]?.push(callback)
        if (event === 'message') {
          queueMicrotask(() => callback({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      once(event: string, callback: (arg?: unknown) => void) {
        handlers[event]?.push(callback)
        return this
      },
      off(event: string, callback: (arg?: unknown) => void) {
        handlers[event] = handlers[event]?.filter((handler) => handler !== callback) ?? []
        return this
      },
      disconnect: vi.fn(() => {
        child.connected = false
      }),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ shutdown(): Promise<void> }>

    await expect(
      launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'launch-delayed')
    ).rejects.toThrow('adoption unavailable')

    expect(writeFileSyncMock).not.toHaveBeenCalled()
    expect(unlinkOwnedDaemonPidFileMock).not.toHaveBeenCalled()
    expect(adoptionDisconnects.at(-1)).toHaveBeenCalledOnce()

    child.exitCode = 0
    for (const callback of handlers.exit.slice()) {
      callback(0)
    }
    expect(unlinkOwnedDaemonPidFileMock).toHaveBeenCalledWith(
      '/fake/daemon.pid',
      12345,
      'launch-delayed'
    )
  })

  it('kills and rejects a daemon whose readiness message omits its start time', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('already exited'), { code: 'ESRCH' })
    })
    const child = {
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready' }))
        }
        return this
      },
      off: vi.fn(),
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    try {
      await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
        'Daemon readiness identity is incomplete'
      )
      expect(kill).toHaveBeenCalledWith(12345, 'SIGTERM')
      expect(writeFileSyncMock).not.toHaveBeenCalled()
      expect(child.disconnect).not.toHaveBeenCalled()
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
    }
  })

  it('rejects startup cleanup when SIGKILL never produces child exit', async () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      const mod = await importFresh()
      checkDaemonHealthMock.mockResolvedValue('unreachable')
      await mod.initDaemonPtyProvider()
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      const child = {
        pid: 12345,
        connected: true,
        exitCode: null,
        signalCode: null,
        on(event: string, callback: (arg?: unknown) => void) {
          handlers[event]?.push(callback)
          if (event === 'message') {
            queueMicrotask(() => callback({ type: 'ready' }))
          }
          return this
        },
        off(event: string, callback: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== callback) ?? []
          return this
        },
        disconnect: vi.fn(() => {
          child.connected = false
        }),
        unref: vi.fn()
      }
      forkMock.mockReturnValueOnce(child)
      const launcher = spawnerInstances[0].launcher as (
        socketPath: string,
        tokenPath: string
      ) => Promise<{ shutdown(): Promise<void> }>

      const launch = launcher('/fake/socket', '/fake/token')
      await Promise.resolve()
      await Promise.resolve()
      const rejection = expect(launch).rejects.toThrow('startup and child cleanup both failed')
      await vi.advanceTimersByTimeAsync(6_000)
      await rejection

      expect(kill).toHaveBeenNthCalledWith(1, 12345, 'SIGTERM')
      expect(kill).toHaveBeenNthCalledWith(2, 12345, 'SIGKILL')
      expect(child.disconnect).toHaveBeenCalledOnce()
      expect(child.unref).toHaveBeenCalledOnce()
      expect(unlinkOwnedDaemonPidFileMock).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
      vi.useRealTimers()
    }
  })

  it('surfaces non-ESRCH startup termination errors and releases IPC', async () => {
    const signalError = Object.assign(new Error('operation not permitted'), {
      code: 'EPERM'
    })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw signalError
    })
    try {
      const mod = await importFresh()
      checkDaemonHealthMock.mockResolvedValue('unreachable')
      await mod.initDaemonPtyProvider()
      const child = {
        pid: 12345,
        connected: true,
        exitCode: null,
        signalCode: null,
        on(event: string, callback: (arg?: unknown) => void) {
          if (event === 'message') {
            queueMicrotask(() => callback({ type: 'ready' }))
          }
          return this
        },
        off: vi.fn(),
        disconnect: vi.fn(() => {
          child.connected = false
        }),
        unref: vi.fn()
      }
      forkMock.mockReturnValueOnce(child)
      const launcher = spawnerInstances[0].launcher as (
        socketPath: string,
        tokenPath: string
      ) => Promise<{ shutdown(): Promise<void> }>

      const error = await launcher('/fake/socket', '/fake/token').catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: 'Daemon readiness identity is incomplete'
        }),
        signalError
      ])
      expect(child.disconnect).toHaveBeenCalledOnce()
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
    }
  })

  it('settles startup with both errors when a malformed-ready child ignores termination', async () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      const mod = await importFresh()
      checkDaemonHealthMock.mockResolvedValue('unreachable')
      await mod.initDaemonPtyProvider()
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      const child = {
        pid: 12345,
        connected: true,
        exitCode: null,
        signalCode: null,
        on(event: string, callback: (arg?: unknown) => void) {
          handlers[event]?.push(callback)
          if (event === 'message') {
            queueMicrotask(() => callback({ type: 'ready' }))
          }
          return this
        },
        off(event: string, callback: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== callback) ?? []
          return this
        },
        disconnect: vi.fn(() => {
          child.connected = false
        }),
        unref: vi.fn()
      }
      forkMock.mockReturnValueOnce(child)
      const launcher = spawnerInstances[0].launcher as (
        socketPath: string,
        tokenPath: string
      ) => Promise<{ shutdown(): Promise<void> }>

      const launch = launcher('/fake/socket', '/fake/token').catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(6_000)
      const error = await launch

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: 'Daemon readiness identity is incomplete'
        }),
        expect.objectContaining({
          message: 'Daemon did not exit after SIGKILL'
        })
      ])
      expect(kill).toHaveBeenNthCalledWith(1, 12345, 'SIGTERM')
      expect(kill).toHaveBeenNthCalledWith(2, 12345, 'SIGKILL')
      expect(handlers.message).toHaveLength(0)
      expect(handlers.error).toHaveLength(0)
      expect(handlers.exit).toHaveLength(0)
      expect(child.disconnect).toHaveBeenCalledOnce()
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
      vi.useRealTimers()
    }
  })

  it('removes detached daemon startup listeners after startup error', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const offMock = vi.fn((event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
      return child
    })
    const child = {
      pid: undefined,
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        if (event === 'error') {
          queueMicrotask(() => cb(new Error('startup failed')))
        }
        return this
      },
      off: offMock,
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow('startup failed')

    expect(offMock).toHaveBeenCalledWith('message', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('error', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('exit', expect.any(Function))
    expect(handlers.message).toHaveLength(0)
    expect(handlers.error).toHaveLength(0)
    expect(handlers.exit).toHaveLength(0)
    expect(child.disconnect).not.toHaveBeenCalled()
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('captures daemon startup stderr into the failure error', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const stderrDataCbs: ((chunk: Buffer) => void)[] = []
    const stderrDestroy = vi.fn()
    const stderr = {
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === 'data') {
          stderrDataCbs.push(cb)
        }
        return this
      },
      off(event: string, cb: (chunk: Buffer) => void) {
        if (event === 'data') {
          const idx = stderrDataCbs.indexOf(cb)
          if (idx !== -1) {
            stderrDataCbs.splice(idx, 1)
          }
        }
        return this
      },
      destroy: stderrDestroy
    }
    const child = {
      pid: 4321,
      exitCode: null as number | null,
      stderr,
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        if (event === 'exit') {
          // Why: deliver the stderr tail before exit so the failure path sees the crash reason (mirrors a module-load crash).
          queueMicrotask(() => {
            for (const dataCb of stderrDataCbs.slice()) {
              dataCb(Buffer.from("Error: Cannot find module 'electron'\n"))
            }
            child.exitCode = 1
            cb(1)
          })
        }
        return this
      },
      off: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
        return child
      }),
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    const error = await launcher(
      '/fake/socket',
      '/fake/token',
      '/fake/daemon.pid',
      'failed-launch'
    ).catch((err: Error) => err)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/Cannot find module 'electron'/)
    expect((error as Error).message).toMatch(/Daemon stderr \(tail\)/)
    expect(unlinkOwnedDaemonPidFileMock).toHaveBeenCalledWith(
      '/fake/daemon.pid',
      4321,
      'failed-launch'
    )
    // Why: release the piped stderr so the detached daemon can't keep the parent event loop alive after failure.
    expect(stderrDestroy).toHaveBeenCalled()
  })
})
