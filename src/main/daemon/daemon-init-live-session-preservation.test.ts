import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  FAKE_USER_DATA_PATH,
  FAKE_RUNTIME_DIR,
  FAKE_DAEMON_ENTRY_PATH
} from './daemon-init-test-harness'

const {
  forkMock,
  checkDaemonHealthMock,
  getMacDaemonSystemResolverHealthMock,
  getDaemonLaunchIdentityMock,
  killStaleDaemonMock,
  daemonClientMock,
  spawnerInstances,
  trackDaemonReplacedMock,
  importFresh,
  mockConnectedAdoptionClientOnce,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

vi.mock('electron', () => moduleFactories.electron())
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

  it('preserves a daemon launched from another app path when it owns live sessions', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return {
          sessions: [
            { sessionId: 'wt-1@@live', isAlive: true },
            { sessionId: 'wt-1@@dead', isAlive: false }
          ]
        }
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')

    await launcher('/fake/socket', '/fake/token')

    expect(getDaemonLaunchIdentityMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      FAKE_DAEMON_ENTRY_PATH
    )
    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('preserves a daemon launched from another app path when live session state cannot be verified', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        throw new Error('listSessions failed')
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')

    await launcher('/fake/socket', '/fake/token')

    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('respawns instead of reusing a protocol-healthy daemon with broken macOS resolver state', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getMacDaemonSystemResolverHealthMock.mockReturnValueOnce('unhealthy')
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 12345,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          if (event === 'message') {
            queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    await launcher('/fake/socket', '/fake/token')

    expect(getMacDaemonSystemResolverHealthMock).toHaveBeenCalledWith('/fake/socket', '/fake/token')
    expect(getDaemonLaunchIdentityMock).not.toHaveBeenCalled()
    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token'
    )
    expect(forkMock).toHaveBeenCalledWith(
      FAKE_DAEMON_ENTRY_PATH,
      expect.arrayContaining([
        '--socket',
        '/fake/socket',
        '--token',
        '/fake/token',
        '--log-file',
        join(FAKE_USER_DATA_PATH, 'logs', 'daemon.log')
      ]),
      expect.objectContaining({ cwd: '/fake/userData', detached: true })
    )
    // STA-2376: the launcher is the sole emitter for a resolver replace, and fires exactly once.
    expect(trackDaemonReplacedMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonReplacedMock).toHaveBeenCalledWith('unhealthy_resolver', 0)
  })

  it('preserves a resolver-unhealthy daemon when it owns live sessions', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return {
          sessions: [
            { sessionId: 'wt-1@@live', isAlive: true },
            { sessionId: 'wt-1@@dead', isAlive: false }
          ]
        }
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getMacDaemonSystemResolverHealthMock.mockReturnValueOnce('unhealthy')

    await launcher('/fake/socket', '/fake/token')

    expect(getMacDaemonSystemResolverHealthMock).toHaveBeenCalledWith('/fake/socket', '/fake/token')
    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(getDaemonLaunchIdentityMock).not.toHaveBeenCalled()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
    // STA-2376: preserving a daemon is not a lifecycle transition — no event.
    expect(trackDaemonReplacedMock).not.toHaveBeenCalled()
  })

  it('preserves a resolver-unhealthy daemon when live session state cannot be verified', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        throw new Error('listSessions failed')
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getMacDaemonSystemResolverHealthMock.mockReturnValueOnce('unhealthy')

    await launcher('/fake/socket', '/fake/token')

    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('preserves a health-check-failing daemon when it owns live sessions', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return {
          sessions: [{ sessionId: 'wt-1@@live', isAlive: true }]
        }
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')

    await launcher('/fake/socket', '/fake/token')

    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('marks a preserved daemon as degraded when its PTY spawn health check fails', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return {
          sessions: [{ sessionId: 'wt-1@@live', isAlive: true }]
        }
      }
      return {}
    })
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: vi.fn()
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{
      mode?: 'degraded-new-pty-fallback'
      shutdown(): Promise<void>
    }>
    checkDaemonHealthMock.mockResolvedValueOnce('pty-spawn-unhealthy')

    const handle = await launcher('/fake/socket', '/fake/token')

    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(handle.mode).toBe('degraded-new-pty-fallback')
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('replaces a health-check-failing daemon when live sessions cannot be verified and the pipe is dead', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {
          throw new Error('daemon is wedged')
        }),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')
    forkMock.mockImplementationOnce(() => ({
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      once() {
        return this
      },
      off() {
        return this
      },
      disconnect: vi.fn(),
      unref: vi.fn()
    }))

    await launcher('/fake/socket', '/fake/token')

    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token'
    )
    expect(forkMock).toHaveBeenCalled()
  })

  it('replaces a health-check-failing daemon when no live sessions would be lost', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 12345,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          if (event === 'message') {
            queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    await launcher('/fake/socket', '/fake/token')

    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token'
    )
    expect(forkMock).toHaveBeenCalledWith(
      FAKE_DAEMON_ENTRY_PATH,
      expect.arrayContaining([
        '--socket',
        '/fake/socket',
        '--token',
        '/fake/token',
        '--log-file',
        join(FAKE_USER_DATA_PATH, 'logs', 'daemon.log')
      ]),
      expect.objectContaining({ detached: true })
    )
  })
})
