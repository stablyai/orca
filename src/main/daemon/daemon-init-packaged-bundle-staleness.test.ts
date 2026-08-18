import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  FAKE_USER_DATA_PATH,
  FAKE_RUNTIME_DIR,
  FAKE_DAEMON_ENTRY_PATH
} from './daemon-init-test-harness'

const {
  isPackagedMock,
  forkMock,
  getDaemonLaunchIdentityMock,
  isDaemonStaleForCurrentBundleMock,
  getMacDaemonTccAttributionHealthMock,
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

  it('preserves a packaged healthy daemon when its app bundle is current', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getDaemonLaunchIdentityMock.mockClear()
    killStaleDaemonMock.mockClear()
    forkMock.mockClear()
    isPackagedMock.mockReturnValue(true)

    await launcher('/fake/socket', '/fake/token')

    expect(getDaemonLaunchIdentityMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      FAKE_DAEMON_ENTRY_PATH
    )
    expect(isDaemonStaleForCurrentBundleMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      '1.2.3'
    )
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('respawns a packaged daemon that predates the current app bundle', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    isPackagedMock.mockReturnValue(true)
    isDaemonStaleForCurrentBundleMock.mockReturnValueOnce(true)
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

    expect(isDaemonStaleForCurrentBundleMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      '1.2.3'
    )
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
    // STA-2376: stale-bundle replacement, emitted exactly once.
    expect(trackDaemonReplacedMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonReplacedMock).toHaveBeenCalledWith('stale_bundle', 0)
    expect(getMacDaemonTccAttributionHealthMock).not.toHaveBeenCalled()
  })

  it('preserves a packaged daemon that predates the current app bundle when it owns live sessions', async () => {
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
    isPackagedMock.mockReturnValue(true)
    isDaemonStaleForCurrentBundleMock.mockReturnValueOnce(true)

    await launcher('/fake/socket', '/fake/token')

    expect(isDaemonStaleForCurrentBundleMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      '1.2.3'
    )
    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })
})
