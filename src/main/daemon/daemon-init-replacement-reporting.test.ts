import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  FAKE_USER_DATA_PATH,
  FAKE_APP_OUT_MAIN_PATH,
  FAKE_DAEMON_ENTRY_PATH
} from './daemon-init-test-harness'

const {
  getAppPathMock,
  probeSocketExistsMock,
  netConnectMock,
  forkMock,
  checkDaemonHealthMock,
  getMacDaemonSystemResolverHealthMock,
  getDaemonLaunchIdentityMock,
  killStaleDaemonMock,
  daemonClientMock,
  spawnerInstances,
  adapterInstances,
  trackDaemonReplacedMock,
  importFresh,
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

  it('uses the direct daemon entry when Electron app path is already out/main', async () => {
    probeSocketExistsMock.mockImplementation((p?: string) => p === FAKE_DAEMON_ENTRY_PATH)
    const mod = await importFresh()
    getAppPathMock.mockReturnValue(FAKE_APP_OUT_MAIN_PATH)
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
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
    // STA-2376: an unreachable daemon with no live sessions is replaced via the failed-health path, once.
    expect(trackDaemonReplacedMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonReplacedMock).toHaveBeenCalledWith('failed_health_check', 0)
  })

  it('does not report a replacement when startup finds no daemon to remove', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    killStaleDaemonMock.mockResolvedValueOnce({
      killed: false,
      liveOwnerSurvived: false
    })
    forkMock.mockImplementationOnce(() => {
      throw new Error('stop after replacement decision')
    })
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>

    await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
      'stop after replacement decision'
    )

    expect(trackDaemonReplacedMock).not.toHaveBeenCalled()
  })

  // STA-2376 regression: dropping the adapter's last authenticated client is enough to make an idle
  // daemon self-retire, so by the time the launcher runs there is nothing to kill and its own
  // confirmed-kill gate reports nothing. The attributed reason keeps the replacement on the wire.
  it.each(['unhealthy_resolver', 'stale_bundle'] as const)(
    'reports the %s replacement even after the daemon self-retired',
    async (reason) => {
      const mod = await importFresh()
      await mod.initDaemonPtyProvider()
      const adapterOptions = adapterInstances[0].options
      trackDaemonReplacedMock.mockClear()

      // The daemon is gone before the launcher looks: nothing answers, nothing left to kill.
      checkDaemonHealthMock.mockResolvedValue('unreachable')
      killStaleDaemonMock
        .mockResolvedValueOnce({ killed: false, liveOwnerSurvived: false })
        .mockResolvedValueOnce({ killed: false, liveOwnerSurvived: false })
      forkMock.mockImplementationOnce(() => {
        throw new Error('stop after replacement decision')
      })
      const launcher = spawnerInstances[0].launcher as (
        socketPath: string,
        tokenPath: string
      ) => Promise<{ shutdown(): Promise<void> }>

      await adapterOptions.respawn?.(reason)
      expect(trackDaemonReplacedMock).not.toHaveBeenCalled()

      await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
        'stop after replacement decision'
      )
      expect(trackDaemonReplacedMock).toHaveBeenCalledTimes(1)
      expect(trackDaemonReplacedMock).toHaveBeenCalledWith(reason, 0)

      // One-shot: a later unrelated launch must not inherit the attribution.
      trackDaemonReplacedMock.mockClear()
      forkMock.mockImplementationOnce(() => {
        throw new Error('stop after replacement decision')
      })
      await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
        'stop after replacement decision'
      )
      expect(trackDaemonReplacedMock).not.toHaveBeenCalled()
    }
  )

  // STA-2376: the attribution covers the case the confirmed-kill gate cannot see; it must not
  // overwrite a reason this launch proved against the daemon it actually removed. Otherwise a
  // resolver that recovers mid-flight bills a real stale-bundle replacement to the resolver bucket.
  it('prefers a proven replacement reason over the attributed one', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const adapterOptions = adapterInstances[0].options
    trackDaemonReplacedMock.mockClear()

    // Resolver recovered by the time the launcher looks, but the daemon is genuinely from another path.
    getMacDaemonSystemResolverHealthMock.mockReturnValue('healthy')
    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')
    forkMock.mockImplementationOnce(() => {
      throw new Error('stop after replacement decision')
    })
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>

    await adapterOptions.respawn?.('unhealthy_resolver')
    await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
      'stop after replacement decision'
    )

    expect(trackDaemonReplacedMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonReplacedMock).toHaveBeenCalledWith('different_app_path', 0)
  })

  // STA-2376: failed_health_check is the residual bucket, not an identification, so it must not
  // absorb the attribution. The same dead login session that fails the resolver also fails the PTY
  // spawn probe, and with zero live sessions that lands here instead of the degraded preserve —
  // so this is the likely shape of the incident, not a corner case.
  it('keeps the attributed reason when the launcher only reaches failed_health_check', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const adapterOptions = adapterInstances[0].options
    trackDaemonReplacedMock.mockClear()

    // Daemon survived the disconnect (non-alive sessions keep it non-idle) but fails the spawn probe.
    checkDaemonHealthMock.mockResolvedValue('pty-spawn-unhealthy')
    forkMock.mockImplementationOnce(() => {
      throw new Error('stop after replacement decision')
    })
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>

    await adapterOptions.respawn?.('unhealthy_resolver')
    await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
      'stop after replacement decision'
    )

    expect(trackDaemonReplacedMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonReplacedMock).toHaveBeenCalledWith('unhealthy_resolver', 0)
  })

  // STA-2376: in the field the identified reasons confirm via cleanupDaemonForProtocol().cleaned, not
  // via killStaleDaemon — the daemon is healthy, so cleanup shuts it down over RPC and unlinks its pid,
  // leaving nothing for the kill to find. The other tests reach confirmedReplacement through the kill,
  // so without this one the `.cleaned` half could be dropped and every identified reason would go
  // silent in production with the suite still green.
  it('reports a replacement confirmed by cleanup alone, with no stale daemon left to kill', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    trackDaemonReplacedMock.mockClear()

    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')
    killStaleDaemonMock.mockResolvedValueOnce({
      killed: false,
      liveOwnerSurvived: false
    })
    // The daemon answers cleanup's liveness probe, then the endpoint goes away so the self-shutdown
    // wait succeeds and cleanup reports cleaned:true.
    probeSocketExistsMock.mockReturnValue(true)
    netConnectMock.mockImplementationOnce(() => {
      const handlers: Record<string, (() => void)[]> = {
        connect: [],
        error: []
      }
      return {
        on(event: string, cb: () => void) {
          handlers[event]?.push(cb)
          if (event === 'connect') {
            queueMicrotask(() => cb())
          }
          return this
        },
        removeListener(event: string, cb: () => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        destroy() {}
      }
    })
    forkMock.mockImplementationOnce(() => {
      throw new Error('stop after replacement decision')
    })
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>

    await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
      'stop after replacement decision'
    )

    expect(killStaleDaemonMock).toHaveBeenCalled()
    expect(trackDaemonReplacedMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonReplacedMock).toHaveBeenCalledWith('different_app_path', 0)

    // beforeEach only mockClear()s this one, so hand it back rather than leaving later tests probing a live endpoint.
    probeSocketExistsMock.mockReturnValue(false)
  })

  it('stays silent about replacing a daemon on a cold start, where there is none', async () => {
    // Why: a first launch reaches the same replace fall-through (unreachable health,
    // no socket, nothing to probe); announcing a replacement there reports killing a
    // daemon that never existed, on the most common path there is.
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    // Both pre-spawn probes fail: nothing ever answers, so no session count is observed.
    const unreachableClient = function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {
          throw new Error('connect ENOENT')
        }),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    }
    daemonClientMock
      .mockImplementationOnce(unreachableClient)
      .mockImplementationOnce(unreachableClient)

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')
    probeSocketExistsMock.mockReturnValue(false)
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

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await launcher('/fake/socket', '/fake/token')

      expect(forkMock).toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Replacing daemon that failed the health check')
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
