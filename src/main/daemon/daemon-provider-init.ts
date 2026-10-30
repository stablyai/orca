import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { rebindLocalProviderListeners } from '../ipc/pty/provider/listener-lifecycle'
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
  discoverNewerProtocolHolds,
  isHoldingForNewerProtocolDaemon
} from './daemon-newer-protocol-hold'
import {
  getDaemonHistoryDir as getHistoryDir,
  getDaemonRuntimeDir as getRuntimeDir,
  resolveStaleDaemonRecycleVersion
} from './daemon-launch-paths'
import {
  attributeNextDaemonReplacement,
  createOutOfProcessLauncher,
  type DaemonLaunchPolicy
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
import { clearSeveredDaemon, installSeveredDaemonController } from './daemon-host-image-state'
import {
  createSeveredDaemonController,
  hasSeveredDaemonBeenReplaced
} from './daemon-severed-restart'

// Use in-process timestamps: daemon init overlaps window loading and harness stderr can arrive late.
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
  options: DaemonLaunchPolicy = {}
): Promise<void> {
  logDaemonMilestone('daemon-init-start')
  // Exercise startup-gate timeout by making daemon init deterministically outlast it.
  const e2eInitDelayMs = Number(process.env.ORCA_E2E_DAEMON_INIT_DELAY_MS)
  if (Number.isFinite(e2eInitDelayMs) && e2eInitDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, e2eInitDelayMs))
  }
  const runtimeDir = getRuntimeDir()

  const newSpawner = new DaemonSpawner({
    runtimeDir,
    launcher: createOutOfProcessLauncher(runtimeDir, options),
    staleDaemonRecycleVersion: resolveStaleDaemonRecycleVersion(
      options.recycleStaleDaemonOnEveryPlatform === true
    )
  })

  // Publish the spawner and adapter together after initialization succeeds.
  const info = await newSpawner.ensureRunning()
  // Reclaim superseded hosts after every adoption or spawn, retaining current and live-pinned versions.
  pruneOldDaemonHosts(collectPinnedDaemonVersions(runtimeDir))
  const launchMode = newSpawner.getHandle()?.mode
  const quarantine = newSpawner.getHandle()?.quarantine
  logDaemonMilestone('daemon-current-ready')
  if (signal?.aborted) {
    // Fallback PTYs may already exist; release the late daemon lease without replacing their provider.
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
    packagedAppVersion: newSpawner.staleDaemonRecycleVersion,
    historyPath: getHistoryDir(),
    respawn: async (reason: DaemonRespawnReason) => {
      // A wedged daemon can look dead here; launch reports the proven replacement cause after recovery.
      if (reason === 'daemon_died') {
        console.warn('[daemon] Daemon process died — respawning')
        // Synthetic exits during manual restart must not enter the crash bucket.
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
    // Overlap temporary and permanent leases so adoption never leaves a gap.
    await newAdapter.establishLifecycleLease()
    releaseDaemonAdoptionLease(newSpawner.getHandle())

    // Adopt older daemons; newer protocols only hold their tabs.
    const [discoveredLegacyAdapters] = await Promise.all([
      createLegacyDaemonAdapters(runtimeDir),
      discoverNewerProtocolHolds(runtimeDir)
    ])
    legacyAdapters = discoveredLegacyAdapters
    routedAdapter =
      launchMode === 'degraded-new-pty-fallback'
        ? new DegradedDaemonPtyProvider({
            current: newAdapter,
            legacy: legacyAdapters,
            fallback: getLocalPtyProvider(),
            // A severed daemon can pass health checks; require a new incarnation before routing fresh terminals.
            probeCurrentDaemonSpawn: async () =>
              (quarantine !== 'host-image-severed' ||
                hasSeveredDaemonBeenReplaced(getDaemonPidPath(runtimeDir))) &&
              (await checkDaemonHealth(info.socketPath, info.tokenPath)) === 'healthy'
          })
        : legacyAdapters.length > 0 || isHoldingForNewerProtocolDaemon()
          ? new DaemonPtyRouter({
              current: newAdapter,
              legacy: legacyAdapters
            })
          : newAdapter
    if (routedAdapter instanceof DegradedDaemonPtyProvider) {
      // Discover existing daemon sessions so fresh terminals can use the local fallback.
      await routedAdapter.discoverDaemonSessions()
    } else if (routedAdapter instanceof DaemonPtyRouter) {
      await routedAdapter.discoverLegacySessions()
    }
    if (signal?.aborted) {
      // Recheck after discovery; release uninstalled leases without killing live sessions.
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
  installSeveredDaemonController(createSeveredDaemonController())
  if (quarantine !== 'host-image-severed') {
    clearSeveredDaemon()
  }
  // The first window can register listeners before init finishes; bind them to the installed provider.
  rebindLocalProviderListeners()
  logDaemonMilestone('daemon-init-done', {
    legacyAdapters: legacyAdapters.length
  })
  if (process.platform === 'darwin' && newSpawner.getHandle()?.adopted) {
    void reportDaemonAdoption(runtimeDir, info.socketPath, info.tokenPath, newAdapter)
  }
}

// Adoption measurements must neither delay nor fail startup.
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
    await trackDaemonAdopted(
      readDaemonPidRecord(getDaemonPidPath(runtimeDir)),
      tccAttribution,
      liveSessionCount
    )
  } catch {
    // Measurement failure must not affect the installed provider.
  }
}
