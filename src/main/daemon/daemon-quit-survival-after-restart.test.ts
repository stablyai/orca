/**
 * What the quit warning is allowed to skip on.
 *
 * Degraded mode spawns fresh terminals on the in-process local provider, so those shells are
 * this process's own children and die with it. A restart that recovers from degraded mode
 * installs a provider that DOES own fresh persistent PTYs — but `shutdownFallbackSessions` is
 * best-effort by design (it logs and continues so fallback cleanup cannot abort the user's
 * recovery), so a restart that SUCCEEDED can still leave one of those shells running.
 *
 * The predicate the quit bypass reads must therefore answer about the PTYs that exist, not
 * about the provider installed at the moment of asking; anything undetermined falls to
 * prompting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ensureRunningOverrides,
  localFallbackProvider,
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

describe('quit survival after a degraded daemon restarts successfully', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function degradeInit(): void {
    ensureRunningOverrides.push(async () => ({
      socketPath: '/fake/degraded-socket',
      tokenPath: '/fake/degraded-token',
      mode: 'degraded-new-pty-fallback'
    }))
  }

  /** Boots into degraded mode, spawns an app-owned shell, then restarts into a healthy daemon. */
  async function degradeThenRestart(mod: Awaited<ReturnType<typeof importFresh>>): Promise<void> {
    degradeInit()
    await mod.initDaemonPtyProvider()
    // A fresh terminal spawned while degraded: routed to the local fallback, so it is this
    // process's own child and dies with it.
    await mod.getDaemonProvider()!.spawn({ cols: 80, rows: 24 })
    await mod.restartDaemon()
  }

  it('keeps prompting while a shell the best-effort shutdown left running is still alive', async () => {
    const mod = await importFresh()
    // The documented best-effort case: the shutdown rejects, the restart continues anyway
    // (fallback cleanup must not abort the user's recovery), and the shell is still there.
    localFallbackProvider.shutdown.mockRejectedValue(new Error('pty shutdown failed'))
    localFallbackProvider.hasPty.mockReturnValue(true)

    await degradeThenRestart(mod)

    expect(
      mod.daemonOwnsFreshPersistentPtys(),
      'the replacement provider really does own fresh persistent PTYs'
    ).toBe(true)
    expect(
      mod.localPtysSurviveQuit(),
      'an app-owned shell that outlived the swap still dies with this process'
    ).toBe(false)
  })

  it('skips the warning once the shutdown really did take those shells down', async () => {
    const mod = await importFresh()
    localFallbackProvider.hasPty.mockReturnValue(false)

    await degradeThenRestart(mod)

    expect(mod.localPtysSurviveQuit()).toBe(true)
  })

  it('prompts when the fallback cannot say whether the shell is still there', async () => {
    const mod = await importFresh()
    localFallbackProvider.shutdown.mockRejectedValue(new Error('pty shutdown failed'))
    // An undetermined answer is not a yes.
    localFallbackProvider.hasPty.mockReturnValue(undefined as unknown as boolean)

    await degradeThenRestart(mod)

    expect(mod.localPtysSurviveQuit()).toBe(false)
  })

  it('still refuses while the degraded provider is the one installed', async () => {
    const mod = await importFresh()
    degradeInit()
    await mod.initDaemonPtyProvider()

    expect(mod.localPtysSurviveQuit()).toBe(false)
  })
})
