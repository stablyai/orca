import { getLocalPtyProvider, rebindLocalProviderListeners } from '../ipc/pty'
import {
  confirmSeededClaudeLivePtys,
  hasSeededUnconfirmedClaudePtys
} from '../claude-accounts/live-pty-gate'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from '../startup/startup-diagnostics'
import { checkDaemonHealth } from './daemon-health'
import { collectPinnedDaemonVersions, pruneOldDaemonHosts } from './daemon-host-relocation'
import {
  cleanupFailedDaemonAdoption,
  releaseDaemonAdoptionLease,
  takeDaemonAdoptionLeaseRelease
} from './daemon-endpoint-adoption'
import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'
import {
  getDaemonHistoryDir as getHistoryDir,
  getDaemonRuntimeDir as getRuntimeDir,
  resolvePackagedDarwinAppVersion
} from './daemon-launch-paths'
import {
  attributeNextDaemonReplacement,
  createOutOfProcessLauncher
} from './daemon-out-of-process-launcher'
import type { DaemonProvider } from './daemon-provider-routing'
import { installDaemonProvider } from './daemon-provider-state'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { trackDaemonAdopted } from './daemon-adoption-telemetry-event'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { trackDaemonRetired } from './daemon-lifecycle-event'
import { getMacDaemonTccAttributionHealth } from './daemon-tcc-attribution'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonRespawnReason } from './daemon-pty-runtime-state'
import { DaemonPtyRouter } from './daemon-pty-router'
import { isDaemonRestartInFlight } from './daemon-restart-state'
import { DaemonSpawner, getDaemonPidPath } from './daemon-spawner'

// Why: daemon init runs concurrent with window load, so an in-process t timestamp (not harness stderr timing) measures cold-start.
function logDaemonMilestone(event: string, details: Record<string, unknown> = {}): void {
  if (isStartupDiagnosticsEnabled()) {
    logStartupDiagnostic(event, {
      t: Math.round(performance.now()),
      ...details
    })
  }
}

export async function initDaemonPtyProvider(
  signal?: AbortSignal,
  options: { macosLoginSessionWatch?: boolean } = {}
): Promise<void> {
  logDaemonMilestone('daemon-init-start')
  // Why: e2e coverage for the startup PTY gate (#5232) needs a daemon init that deterministically outlasts the first-window timeout.
  const e2eInitDelayMs = Number(process.env.ORCA_E2E_DAEMON_INIT_DELAY_MS)
  if (Number.isFinite(e2eInitDelayMs) && e2eInitDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, e2eInitDelayMs))
  }
  const runtimeDir = getRuntimeDir()

  const newSpawner = new DaemonSpawner({
    runtimeDir,
    launcher: createOutOfProcessLauncher(runtimeDir, options.macosLoginSessionWatch ?? false)
  })

  // Why: assign the module-level spawner/adapter only after both succeed, so a failed ensureRunning() leaves no stale spawner.
  const info = await newSpawner.ensureRunning()
  // Why: reclaim superseded daemon-host copies on EVERY launch (spawns are rare), keeping current + live-daemon-pinned versions.
  pruneOldDaemonHosts(collectPinnedDaemonVersions(runtimeDir))
  const launchMode = newSpawner.getHandle()?.mode
  logDaemonMilestone('daemon-current-ready')
  if (signal?.aborted) {
    // Why: fail-open may already have spawned fallback PTYs; don't install late, but retire an empty daemon (live sessions reject it and survive).
    const abortedStartupAdapter = new DaemonPtyAdapter({
      socketPath: info.socketPath,
      tokenPath: info.tokenPath,
      pidPath: getDaemonPidPath(runtimeDir),
      profileScope: runtimeDir,
      runtimeDir
    })
    releaseDaemonAdoptionLease(newSpawner.getHandle())
    await abortedStartupAdapter.disconnectOnly()
    return
  }

  const newAdapter = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    pidPath: getDaemonPidPath(runtimeDir),
    profileScope: runtimeDir,
    runtimeDir,
    packagedAppVersion: resolvePackagedDarwinAppVersion(),
    historyPath: getHistoryDir(),
    // Why: on daemon death, ensureConnected() detects the dead socket and calls this to fork a replacement before retrying.
    respawn: async (reason: DaemonRespawnReason) => {
      // Why: attribute rather than emit — the launcher below is the one that completes the
      // replacement, and emitting here would fire before the outcome is known.
      // Caveat: a wedged-but-alive daemon (#8689) can still report died_respawn here and
      // failed_health_check from the launcher — the app cannot tell wedged from dead at this point.
      if (reason === 'daemon_died') {
        console.warn('[daemon] Daemon process died — respawning')
        // Why: a manual restart tears the daemon down under a still-live adapter, so a pane
        // respawning on its synthetic exit would bill a user action to the crash bucket.
        if (!isDaemonRestartInFlight()) {
          trackDaemonRetired('died_respawn')
        }
      } else {
        // Must reach the launcher below without an await in between; see the consume site.
        attributeNextDaemonReplacement(reason)
      }
      newSpawner.resetHandle()
      await newSpawner.ensureRunning()
      return takeDaemonAdoptionLeaseRelease(newSpawner.getHandle())
    }
  })
  let legacyAdapters: DaemonPtyAdapter[] = []
  let routedAdapter: DaemonProvider = newAdapter
  try {
    // Why: the launcher's temporary pair closes only after this permanent pair is established, leaving no adoption gap.
    await newAdapter.establishLifecycleLease()
    releaseDaemonAdoptionLease(newSpawner.getHandle())

    legacyAdapters = await createLegacyDaemonAdapters(runtimeDir)
    routedAdapter =
      launchMode === 'degraded-new-pty-fallback'
        ? new DegradedDaemonPtyProvider({
            current: newAdapter,
            legacy: legacyAdapters,
            fallback: getLocalPtyProvider(),
            probeCurrentDaemonSpawn: async () =>
              (await checkDaemonHealth(info.socketPath, info.tokenPath)) === 'healthy'
          })
        : legacyAdapters.length > 0
          ? new DaemonPtyRouter({
              current: newAdapter,
              legacy: legacyAdapters
            })
          : newAdapter
    if (routedAdapter instanceof DegradedDaemonPtyProvider) {
      // Why: preserved daemon can't create fresh terminals; discover its live session ids so only they route to it (fresh panes fall back locally).
      await routedAdapter.discoverDaemonSessions()
    } else if (routedAdapter instanceof DaemonPtyRouter) {
      await routedAdapter.discoverLegacySessions()
    }
    if (signal?.aborted) {
      // Why: same late-swap guard after legacy discovery; release uninstalled adapter leases without killing live sessions.
      await routedAdapter.disconnectOnly()
      return
    }
  } catch (error) {
    try {
      await cleanupFailedDaemonAdoption(newSpawner, newAdapter, legacyAdapters)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Daemon adoption and cleanup both failed')
    }
    throw error
  }
  installDaemonProvider(newSpawner, routedAdapter)
  // Why: the first window may register PTY listeners before daemon init finishes; rebind so daemon PTYs still fan out events.
  rebindLocalProviderListeners()
  logDaemonMilestone('daemon-init-done', {
    legacyAdapters: legacyAdapters.length
  })
  if (process.platform === 'darwin' && newSpawner.getHandle()?.adopted) {
    void reportDaemonAdoption(runtimeDir, info.socketPath, info.tokenPath, newAdapter)
  }
  await reconcileSeededClaudeLivePtys(routedAdapter)
}

// Why off the init path: this is measurement of an adopted daemon (#17696), and neither its probes nor their failure may delay or fail startup.
async function reportDaemonAdoption(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  adapter: DaemonPtyAdapter
): Promise<void> {
  try {
    const [tccAttribution, liveSessionCount] = await Promise.all([
      getMacDaemonTccAttributionHealth(runtimeDir, socketPath, tokenPath),
      adapter.listSessions().then(
        (sessions) => sessions.length,
        () => null
      )
    ])
    trackDaemonAdopted(
      readDaemonPidRecord(getDaemonPidPath(runtimeDir)),
      tccAttribution,
      liveSessionCount
    )
  } catch {
    // Best-effort measurement only.
  }
}

// Why: release gate ids only for daemon-confirmed-dead sessions; keep seeds on listing failure since releasing early can rotate a live CLI's refresh token.
async function reconcileSeededClaudeLivePtys(provider: DaemonProvider): Promise<void> {
  if (!hasSeededUnconfirmedClaudePtys()) {
    return
  }
  try {
    const adapters =
      provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider
        ? provider.getAllAdapters()
        : [provider]
    const results = await Promise.allSettled(adapters.map((entry) => entry.listSessions()))
    if (results.some((result) => result.status === 'rejected')) {
      console.warn('[daemon] Keeping seeded Claude live-PTY gate — session listing failed')
      return
    }
    confirmSeededClaudeLivePtys(
      results.flatMap((result) =>
        result.status === 'fulfilled' ? result.value.map((session) => session.sessionId) : []
      )
    )
  } catch (error) {
    // Why: gate bookkeeping must never fail daemon init; stale seeds only defer a usage refresh until next restart.
    console.warn('[daemon] Failed to reconcile seeded Claude live-PTY gate:', error)
  }
}
