import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  checkDaemonHealthMock,
  ensureRunningOverrides,
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
vi.mock('../../../health/daemon-health', () => moduleFactories.daemonHealth())
vi.mock('../../../endpoint/identity/daemon-pid-identity', () => moduleFactories.daemonPidIdentity())
vi.mock('../../../permissions/daemon-tcc-attribution', () => moduleFactories.daemonTccAttribution())
vi.mock('../../../launch/daemon-bundle-staleness', () => moduleFactories.daemonBundleStaleness())
vi.mock('../../../launch/daemon-stale-kill', () => moduleFactories.daemonStaleKill())
vi.mock('../../../endpoint/identity/daemon-process-start-time', () =>
  moduleFactories.daemonProcessStartTime()
)
vi.mock('../../../endpoint/identity/daemon-pid-file-parse', () =>
  moduleFactories.daemonPidFileParse()
)
vi.mock('../../../transport/client/daemon-client', () => moduleFactories.client())
vi.mock('../../../observability/daemon-lifecycle-event', () =>
  moduleFactories.daemonLifecycleEvent()
)
vi.mock('../../../launch/daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('../../adapter/daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../../../../ipc/pty/provider/registry', () => moduleFactories.ptyProviderRegistry())
vi.mock('../../../../ipc/pty/provider/listener-lifecycle', () =>
  moduleFactories.ptyListenerLifecycle()
)
vi.mock('../../../executable-host/linux/daemon-host-image', () => ({
  inspectDaemonHostImage: () => ({
    verdict: hostImage.verdict,
    pid: hostImage.pid,
    linuxStartTicks: '777',
    bootId: 'boot-1'
  })
}))

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
    ;(await import('../daemon-host-image-state')).clearSeveredDaemon()
  })

  it('never re-admits fresh terminals to a quarantined daemon on a healthy check', async () => {
    const mod = await importFresh()
    ;(await import('../daemon-host-image-state')).noteSeveredDaemon({
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

    const { DegradedDaemonPtyProvider } = await import('../../routing/degraded-daemon-pty-provider')
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
})
