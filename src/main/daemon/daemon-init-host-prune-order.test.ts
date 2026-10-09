import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnerInstances, importFresh, installDefaultNetConnectStub, moduleFactories } =
  await vi.hoisted(async () => (await import('./daemon-init-test-harness')).createDaemonInitMocks())
const relocation = vi.hoisted(() => ({
  collectPinnedDaemonVersions: vi.fn((_runtimeDir: string) => ({
    status: 'complete',
    versionLiveness: new Map()
  })),
  getRelocatedDaemonHost: vi.fn(() => null),
  materializeRelocatedDaemonHost: vi.fn(() => null),
  pruneDaemonHostsBeforeLaunch: vi.fn(),
  pruneOldDaemonHosts: vi.fn()
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
vi.mock('./daemon-host-relocation', () => relocation)

describe('daemon-init: daemon-host prune order', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('prunes from the runtime pid evidence before a replacement daemon can pin mirrors', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const ensureRunning = spawnerInstances[0].ensureRunning
    expect(relocation.pruneDaemonHostsBeforeLaunch).toHaveBeenCalledOnce()
    expect(relocation.pruneDaemonHostsBeforeLaunch).toHaveBeenCalledWith(
      relocation.collectPinnedDaemonVersions.mock.calls[0]?.[0]
    )
    expect(relocation.collectPinnedDaemonVersions.mock.calls[0]?.[0]).toEqual(expect.any(String))
    expect(relocation.pruneDaemonHostsBeforeLaunch.mock.invocationCallOrder[0]).toBeLessThan(
      ensureRunning.mock.invocationCallOrder[0]
    )
    expect(relocation.pruneOldDaemonHosts.mock.invocationCallOrder[0]).toBeGreaterThan(
      ensureRunning.mock.invocationCallOrder[0]
    )
  })
})
