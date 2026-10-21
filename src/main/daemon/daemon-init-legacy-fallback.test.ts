import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/pty-provider-contract'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { PROTOCOL_VERSION } from './types'

const {
  probeSocketExistsMock,
  listProcessesControl,
  adapterInstances,
  ensureRunningOverrides,
  localFallbackProvider,
  setLocalPtyProviderMock,
  rebindLocalProviderListenersMock,
  importFresh,
  mockOnlyDaemonSocketAlive,
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
vi.mock('./daemon-adoption-telemetry-event', () => moduleFactories.daemonAdoptionTelemetryEvent())
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty/provider/registry', () => moduleFactories.ptyProviderRegistry())
vi.mock('../ipc/pty/provider/listener-lifecycle', () => moduleFactories.ptyListenerLifecycle())

type DaemonSurface = IPtyProvider & {
  reconcileOnStartup: (
    validWorktreeIds: Set<string>
  ) => Promise<{ alive: string[]; killed: string[] }>
}

function createDaemonSurface(label: string, sessions: string[] = []): DaemonSurface {
  return {
    spawn: vi.fn(async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
      const id = opts.sessionId ?? `${label}-new`
      sessions.push(id)
      return { id }
    }),
    attach: vi.fn(async () => {}),
    hasPty: vi.fn((id: string) => sessions.includes(id)),
    write: vi.fn(),
    writeWithSettlement: vi.fn(settledWriteStub()),
    resize: vi.fn(),
    shutdown: vi.fn(async () => {}),
    sendSignal: vi.fn(async () => {}),
    getCwd: vi.fn(async () => ''),
    getInitialCwd: vi.fn(async () => ''),
    clearBuffer: vi.fn(async () => {}),
    resetInputModes: vi.fn(async () => {}),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(async () => false),
    getForegroundProcess: vi.fn(async () => null),
    serialize: vi.fn(async () => '{}'),
    revive: vi.fn(async () => {}),
    listProcesses: vi.fn(async () => sessions.map((id) => ({ id, cwd: '', title: label }))),
    getDefaultShell: vi.fn(async () => '/bin/zsh'),
    getProfiles: vi.fn(async () => []),
    reconcileOnStartup: vi.fn(async () => ({ alive: [...sessions], killed: [] })),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {})
  }
}

function asDaemonAdapter(surface: DaemonSurface): DaemonPtyAdapter {
  // SAFETY: the surface implements the adapter calls DegradedDaemonPtyProvider makes in these tests.
  return surface as unknown as DaemonPtyAdapter
}

describe('DegradedDaemonPtyProvider current startup failure', () => {
  it('keeps inventory and attach on legacy adapters and fresh spawns on the local fallback', async () => {
    const current = createDaemonSurface('current')
    const legacySessions = ['legacy-session']
    const legacy = createDaemonSurface('legacy', legacySessions)
    const fallback = createDaemonSurface('fallback')
    const provider = new DegradedDaemonPtyProvider({
      current: asDaemonAdapter(current),
      legacy: [asDaemonAdapter(legacy)],
      fallback,
      currentAvailable: false
    })

    await provider.discoverDaemonSessions()
    await provider.listProcesses()
    await provider.reconcileOnStartup(new Set())
    await provider.spawn({
      sessionId: 'legacy-session',
      attachOnly: true,
      cols: 80,
      rows: 24
    })
    await provider.spawn({ cols: 80, rows: 24 })

    expect(current.listProcesses).not.toHaveBeenCalled()
    expect(current.reconcileOnStartup).not.toHaveBeenCalled()
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.listProcesses).toHaveBeenCalled()
    expect(legacy.reconcileOnStartup).toHaveBeenCalledOnce()
    expect(legacy.spawn).toHaveBeenCalledOnce()
    expect(fallback.spawn).toHaveBeenCalledOnce()
    expect(fallback.spawn).toHaveBeenCalledWith({ cols: 80, rows: 24 })
  })

  it('admits the current adapter after its spawn probe recovers', async () => {
    const current = createDaemonSurface('current')
    const provider = new DegradedDaemonPtyProvider({
      current: asDaemonAdapter(current),
      legacy: [],
      fallback: createDaemonSurface('fallback'),
      currentAvailable: false,
      probeCurrentDaemonSpawn: async () => true
    })

    await expect(provider.recoverFreshSpawnRouting()).resolves.toBe(true)
    await provider.listProcesses()

    expect(current.listProcesses).toHaveBeenCalledOnce()
  })
})

describe('initDaemonPtyProvider legacy fallback', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('installs a degraded provider over a live legacy daemon when current startup fails', async () => {
    const mod = await importFresh()
    const failure = new Error('protocol-mismatch')
    const legacySession = {
      sessionId: 'legacy-live-session',
      id: 'legacy-live-session',
      cwd: '/repo',
      title: 'agy'
    }
    probeSocketExistsMock.mockImplementation(
      (socketPath?: string) => socketPath?.endsWith('daemon-v49.sock') ?? false
    )
    mockOnlyDaemonSocketAlive('daemon-v49.sock')
    listProcessesControl.current = async () => [legacySession]
    ensureRunningOverrides.push(async () => {
      throw failure
    })

    await mod.initDaemonPtyProvider()

    const { DegradedDaemonPtyProvider: InstalledDegradedDaemonPtyProvider } =
      await import('./degraded-daemon-pty-provider')
    const provider = mod.getDaemonProvider()
    expect(provider).toBeInstanceOf(InstalledDegradedDaemonPtyProvider)
    if (!(provider instanceof InstalledDegradedDaemonPtyProvider)) {
      throw new Error('expected DegradedDaemonPtyProvider')
    }
    const current = adapterInstances[0]
    const legacy = adapterInstances[1]
    expect(adapterInstances.map((instance) => instance.protocolVersion)).toEqual([
      PROTOCOL_VERSION,
      49
    ])
    expect(provider.getCurrentAdapter()).toBe(current)
    expect(provider.getLegacyAdapters()).toEqual([legacy])
    expect(provider.getAllAdapters()).toEqual([legacy])
    expect(current.listProcesses).not.toHaveBeenCalled()
    expect(current.disconnectOnly).toHaveBeenCalledOnce()
    expect(legacy.listProcesses).toHaveBeenCalled()
    expect(setLocalPtyProviderMock).toHaveBeenCalledWith(provider)
    expect(rebindLocalProviderListenersMock).toHaveBeenCalledOnce()

    const spawn = vi.fn(async (opts: { sessionId?: string }) => ({
      id: opts.sessionId ?? 'missing-session',
      isReattach: true
    }))
    Object.assign(legacy, { spawn })
    await provider.spawn({
      sessionId: 'legacy-live-session',
      attachOnly: true,
      cols: 80,
      rows: 24
    })
    await provider.spawn({ cols: 80, rows: 24 })

    expect(spawn).toHaveBeenCalledOnce()
    expect(localFallbackProvider.spawn).toHaveBeenCalledOnce()
    expect(current.listProcesses).not.toHaveBeenCalled()
    await expect(provider.listProcesses()).resolves.toEqual([legacySession])
  })

  it('rethrows the current startup error when no legacy daemon is alive', async () => {
    const mod = await importFresh()
    const failure = new Error('protocol-mismatch')
    ensureRunningOverrides.push(async () => {
      throw failure
    })

    await expect(mod.initDaemonPtyProvider()).rejects.toBe(failure)

    expect(mod.getDaemonProvider()).toBeNull()
    expect(setLocalPtyProviderMock).not.toHaveBeenCalled()
    expect(rebindLocalProviderListenersMock).not.toHaveBeenCalled()
    expect(adapterInstances).toHaveLength(1)
    expect(adapterInstances[0].disconnectOnly).toHaveBeenCalledOnce()
  })
})
