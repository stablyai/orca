/* daemon-provider-init's legacy generation-registry-build deadline: it must share the
 * SAME 60s startup fail-open cutoff the caller's abort signal fires on
 * (first-window-startup-services.ts), never a flat per-call budget stacked on top of
 * however much of that window ensureRunning() already spent. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS } from '../startup/first-window-startup-services'

const {
  ensureRunningOverrides,
  importFresh,
  installDefaultNetConnectStub,
  moduleFactories,
  createLegacyDaemonAdaptersMock
} = await vi.hoisted(async () => {
  const harness = (await import('./daemon-init-test-harness')).createDaemonInitMocks()
  const { vi: vitestVi } = await import('vitest')
  return { ...harness, createLegacyDaemonAdaptersMock: vitestVi.fn() }
})

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
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())

describe('initDaemonPtyProvider: legacy registry-build deadline', () => {
  // Pinned by daemon-init-wedged-daemon-grace.test.ts: DAEMON_RECOVERY_BUDGET_MS (32s) plus
  // the post-recovery kill/fork/lease chain (10.5s + 10s + 5s = 25.5s) is the documented
  // worst case ensureRunning() may spend before the registry-build call site is reached.
  const WORST_CASE_ENSURE_RUNNING_MS = 32_000 + (3_000 + 3_000 + 3_000 + 1_000 + 500) + 10_000 + 5_000

  beforeEach(() => {
    installDefaultNetConnectStub()
    createLegacyDaemonAdaptersMock.mockReset()
    createLegacyDaemonAdaptersMock.mockResolvedValue({ adapters: [], registry: [] })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the registry-build deadline inside the 60s fail-open cutoff even after ensureRunning() spends the documented 32s + 25.5s worst case', async () => {
    const mod = await importFresh()

    const startedAtMs = 1_700_000_000_000
    const clock = { now: startedAtMs }
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now)

    ensureRunningOverrides.push(async () => {
      clock.now += WORST_CASE_ENSURE_RUNNING_MS
      return { socketPath: '/fake/socket-wedge', tokenPath: '/fake/token-wedge' }
    })

    try {
      await mod.initDaemonPtyProvider()
    } finally {
      nowSpy.mockRestore()
    }

    expect(createLegacyDaemonAdaptersMock).toHaveBeenCalledTimes(1)
    const [, , deadlineMs] = createLegacyDaemonAdaptersMock.mock.calls[0]

    // Old bug: Date.now() at call time (startedAtMs + 57_500) plus a flat
    // LEGACY_GENERATION_REGISTRY_BUILD_BUDGET_MS (10s) = startedAtMs + 67_500, 7.5s past the
    // 60s fail-open cutoff. The fix anchors the deadline to daemon-init's own start instead.
    expect(deadlineMs).toBeLessThanOrEqual(startedAtMs + LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS)
    expect(deadlineMs).toBe(startedAtMs + LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS)
  })

  it('gives the registry build most of the 60s window on the fast (non-wedged) path', async () => {
    const mod = await importFresh()

    const beforeMs = Date.now()
    await mod.initDaemonPtyProvider()
    const afterMs = Date.now()

    expect(createLegacyDaemonAdaptersMock).toHaveBeenCalledTimes(1)
    const [, , deadlineMs] = createLegacyDaemonAdaptersMock.mock.calls[0]

    expect(deadlineMs).toBeGreaterThanOrEqual(beforeMs + LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS)
    expect(deadlineMs).toBeLessThanOrEqual(afterMs + LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS)
  })
})
