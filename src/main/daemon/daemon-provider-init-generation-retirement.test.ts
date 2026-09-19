import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonPtyRouter } from './daemon-pty-router'

const { importFresh, installDefaultNetConnectStub, moduleFactories } = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

const startMock = vi.fn()
const constructorSpy = vi.fn()
const createLegacyDaemonAdaptersMock = vi.fn(
  async (): Promise<{ adapters: DaemonPtyAdapter[]; registry: unknown[] }> => ({
    adapters: [],
    registry: []
  })
)

vi.mock('./daemon-generation-retirement', () => ({
  DaemonGenerationRetirementScheduler: class {
    constructor(deps: unknown) {
      constructorSpy(deps)
    }
    start = startMock
  }
}))

vi.mock('./daemon-legacy-adapters', () => ({
  createLegacyDaemonAdapters: createLegacyDaemonAdaptersMock
}))

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
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())

function fakeLegacyAdapter(): DaemonPtyAdapter {
  return {
    protocolVersion: 22,
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(async () => [])
  } as unknown as DaemonPtyAdapter
}

describe('daemon-provider-init: generation retirement scheduler wiring', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
    startMock.mockClear()
    constructorSpy.mockClear()
    createLegacyDaemonAdaptersMock.mockReset()
    createLegacyDaemonAdaptersMock.mockResolvedValue({ adapters: [], registry: [] })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('starts the scheduler with the installed router once a legacy generation is discovered', async () => {
    createLegacyDaemonAdaptersMock.mockResolvedValue({
      adapters: [fakeLegacyAdapter()],
      registry: []
    })
    const mod = await importFresh()

    await mod.initDaemonPtyProvider()

    expect(constructorSpy).toHaveBeenCalledTimes(1)
    // Why not toBeInstanceOf(DaemonPtyRouter): importFresh() re-imports the whole
    // daemon-init module graph under a reset registry, so the router class this
    // test file's own static import binds is a DIFFERENT identity than the one
    // daemon-provider-init.ts constructed against -- a dual-module-instance
    // artifact of the harness, not a real behavioral question. Assert the SHAPE
    // (a live router carrying exactly the discovered legacy adapter) instead.
    const deps = constructorSpy.mock.calls[0][0] as {
      router: DaemonPtyRouter
      runtimeDir: string
    }
    expect(deps.router.getLegacyAdapters()).toHaveLength(1)
    expect(deps.runtimeDir).toBeTruthy()
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  it('never starts the scheduler when no legacy generation was discovered', async () => {
    const mod = await importFresh()

    await mod.initDaemonPtyProvider()

    expect(constructorSpy).not.toHaveBeenCalled()
    expect(startMock).not.toHaveBeenCalled()
  })
})
