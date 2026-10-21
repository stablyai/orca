import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  forkMock,
  checkDaemonHealthMock,
  getDaemonLaunchIdentityMock,
  killStaleDaemonMock,
  daemonClientMock,
  spawnerInstances,
  ensureRunningOverrides,
  trackDaemonReplacedMock,
  localFallbackProvider,
  importFresh,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

const hostImage = vi.hoisted(() => {
  const state: { verdict: 'intact' | 'severed' | 'unknown' | 'not-ephemeral'; pid: number } = {
    verdict: 'not-ephemeral',
    pid: 4288
  }
  return state
})

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
vi.mock('../ipc/pty/provider/registry', () => moduleFactories.ptyProviderRegistry())
vi.mock('../ipc/pty/provider/listener-lifecycle', () => moduleFactories.ptyListenerLifecycle())
vi.mock('./daemon-host-image', () => ({
  inspectDaemonHostImage: () => ({
    verdict: hostImage.verdict,
    pid: hostImage.pid,
    linuxStartTicks: '777',
    bootId: 'boot-1'
  })
}))

type Launcher = (
  socketPath: string,
  tokenPath: string,
  pidPath?: string,
  launchNonce?: string
) => Promise<{ mode?: string; quarantine?: string; releaseAdoptionLease?(): void }>

function isLauncher(value: unknown): value is Launcher {
  return typeof value === 'function'
}

function launcher(): Launcher {
  const candidate = spawnerInstances[0].launcher
  if (!isLauncher(candidate)) {
    throw new Error('launcher not captured')
  }
  return candidate
}

function mockDaemonWithLiveSessions(count: number): void {
  daemonClientMock.mockImplementation(function MockDaemonClient() {
    return {
      ensureConnected: vi.fn(async () => {}),
      ensureConnectedWithin: vi.fn(async () => {}),
      request: vi.fn(async () => ({
        sessions: Array.from({ length: count }, (_, index) => ({
          sessionId: `s${index}`,
          isAlive: true
        }))
      })),
      disconnect: vi.fn()
    }
  })
}

function mockReadyFork(): void {
  forkMock.mockImplementationOnce(() => ({
    pid: 12345,
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'message') {
        queueMicrotask(() => cb({ type: 'ready', pid: 12345, startedAtMs: 1_000_000 }))
      }
      return this
    },
    off() {
      return this
    },
    disconnect: vi.fn(),
    unref: vi.fn()
  }))
}

describe('daemon-init: a daemon whose AppImage files are gone', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    installDefaultNetConnectStub()
    hostImage.verdict = 'severed'
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    hostImage.verdict = 'not-ephemeral'
    hostImage.pid = 4288
    warn.mockRestore()
    vi.clearAllMocks()
    ;(await import('./daemon-host-image-state')).clearSeveredDaemon()
  })

  it('keeps a busy daemon from another mount but quarantines it from fresh terminals', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    // A previous mount always reads as a different app path; that branch would adopt it normally.
    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')
    mockDaemonWithLiveSessions(2)

    const handle = await launcher()('/fake/socket', '/fake/token')

    expect(handle.mode).toBe('degraded-new-pty-fallback')
    expect(handle.quarantine).toBe('host-image-severed')
    expect(forkMock).not.toHaveBeenCalled()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    const state = await import('./daemon-host-image-state')
    expect(state.getSeveredDaemon()).toEqual({
      pid: 4288,
      linuxStartTicks: '777',
      bootId: 'boot-1'
    })
    handle.releaseAdoptionLease?.()
  })

  it('replaces an idle daemon whose AppImage files are gone', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    mockReadyFork()

    await launcher()('/fake/socket', '/fake/token')

    expect(forkMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonReplacedMock).toHaveBeenCalledWith('severed_host_image', 0)
  })

  it('quarantines a daemon kept by the failed-health branch too', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    checkDaemonHealthMock.mockResolvedValueOnce('unresponsive')
    mockDaemonWithLiveSessions(1)

    const handle = await launcher()('/fake/socket', '/fake/token')

    expect(handle.quarantine).toBe('host-image-severed')
    expect(handle.mode).toBe('degraded-new-pty-fallback')
    expect(forkMock).not.toHaveBeenCalled()
    handle.releaseAdoptionLease?.()
  })

  it('leaves intact and non-AppImage daemons on the existing adoption policy', async () => {
    hostImage.verdict = 'intact'
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    mockDaemonWithLiveSessions(1)

    const handle = await launcher()('/fake/socket', '/fake/token')

    expect(handle.mode).toBeUndefined()
    expect(handle.quarantine).toBeUndefined()
    handle.releaseAdoptionLease?.()
  })

  it('never re-admits fresh terminals to a quarantined daemon on a healthy check', async () => {
    const mod = await importFresh()
    ;(await import('./daemon-host-image-state')).noteSeveredDaemon({
      verdict: 'severed',
      pid: 4288,
      linuxStartTicks: '777',
      bootId: 'boot-1'
    })
    ensureRunningOverrides.push(async () => ({
      socketPath: '/fake/severed-socket',
      tokenPath: '/fake/severed-token',
      mode: 'degraded-new-pty-fallback',
      quarantine: 'host-image-severed'
    }))
    await mod.initDaemonPtyProvider()
    checkDaemonHealthMock.mockResolvedValue('healthy')

    const { DegradedDaemonPtyProvider } = await import('./degraded-daemon-pty-provider')
    const provider = mod.getDaemonProvider()
    expect(provider).toBeInstanceOf(DegradedDaemonPtyProvider)
    if (!(provider instanceof DegradedDaemonPtyProvider)) {
      throw new Error('expected degraded routing')
    }
    const degraded = provider

    await expect(degraded.recoverFreshSpawnRouting()).resolves.toBe(false)
    const result = await degraded.spawn({ cols: 80, rows: 24 })
    expect(result.id).toBe('local-fallback-pty')
    expect(localFallbackProvider.spawn).toHaveBeenCalled()
  })

  it('lets fresh terminals back once a new daemon incarnation owns the endpoint', async () => {
    const mod = await importFresh()
    const state = await import('./daemon-host-image-state')
    state.noteSeveredDaemon({
      verdict: 'severed',
      pid: 4288,
      linuxStartTicks: '777',
      bootId: 'boot-1'
    })
    ensureRunningOverrides.push(async () => ({
      socketPath: '/fake/severed-socket',
      tokenPath: '/fake/severed-token',
      mode: 'degraded-new-pty-fallback',
      quarantine: 'host-image-severed'
    }))
    await mod.initDaemonPtyProvider()
    checkDaemonHealthMock.mockResolvedValue('healthy')
    const { DegradedDaemonPtyProvider } = await import('./degraded-daemon-pty-provider')
    const provider = mod.getDaemonProvider()
    if (!(provider instanceof DegradedDaemonPtyProvider)) {
      throw new Error('expected degraded routing')
    }

    // The severed daemon crashed and its adapter respawned a new one at the endpoint.
    hostImage.verdict = 'intact'
    hostImage.pid = 9000

    await expect(provider.recoverFreshSpawnRouting()).resolves.toBe(true)
    expect(state.getSeveredDaemon()).toBeNull()
  })
})
