import { rebindLocalProviderListeners, unbindLocalProviderListeners } from '../ipc/pty'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import {
  cleanupFailedDaemonAdoption,
  releaseDaemonAdoptionLease,
  takeDaemonAdoptionLeaseRelease
} from './daemon-endpoint-adoption'
import {
  getDaemonHistoryDir as getHistoryDir,
  getDaemonRuntimeDir as getRuntimeDir,
  resolvePackagedDarwinAppVersion
} from './daemon-launch-paths'
import { trackDaemonRetired } from './daemon-lifecycle-event'
import { attributeNextDaemonReplacement } from './daemon-out-of-process-launcher'
import {
  disposeProviderSubscriptionsOnly,
  getCurrentDaemonAdapter,
  getLegacyDaemonAdapters,
  type DaemonProvider
} from './daemon-provider-routing'
import { getDaemonProvider, getDaemonSpawner, replaceDaemonProvider } from './daemon-provider-state'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonRespawnReason } from './daemon-pty-runtime-state'
import { DaemonPtyRouter } from './daemon-pty-router'
import { cleanupDaemonForProtocol } from './daemon-protocol-cleanup'
import {
  isDaemonRestartInFlight,
  runCoalescedDaemonRestart,
  type RestartDaemonResult
} from './daemon-restart-state'
import { getDaemonPidPath, type DaemonSpawner } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'

export type { RestartDaemonResult } from './daemon-restart-state'

// Why: the 7-step restart sequence from docs/daemon-staleness-ux.md §Phase 1; current-protocol only (legacy adapters preserved).
export async function restartDaemon(): Promise<RestartDaemonResult> {
  return runCoalescedDaemonRestart(runRestartDaemon)
}

async function runRestartDaemon(): Promise<RestartDaemonResult> {
  const currentSpawner = getDaemonSpawner()
  const currentAdapter = getDaemonProvider()
  if (!currentSpawner || !currentAdapter) {
    throw new Error('restartDaemon called before initDaemonPtyProvider')
  }

  const runtimeDir = getRuntimeDir()
  // An operator asking for a restart is the deliberate "try again" that clears crash-loop
  // containment; without this a wedged host could never be recovered from the UI.
  currentSpawner.resetRespawnWindow()
  const currentOnly = getCurrentDaemonAdapter(currentAdapter)
  const legacyAdapters = getLegacyDaemonAdapters(currentAdapter)

  // Step 1: synthesize pty:exit for every active session BEFORE teardown — the daemon's shutdown path never fans onExit to clients (session.ts:246-252), so the renderer would otherwise never see exits.
  const fallbackKilledCount =
    currentAdapter instanceof DegradedDaemonPtyProvider
      ? await currentAdapter.shutdownFallbackSessions()
      : 0
  const currentDaemonSessionIds =
    currentAdapter instanceof DegradedDaemonPtyProvider
      ? currentAdapter.getCurrentDaemonSessionIds()
      : []
  const killedCount =
    new Set([...currentOnly.getActiveSessionIds(), ...currentDaemonSessionIds]).size +
    fallbackKilledCount
  currentOnly.fanoutSyntheticExits(-1)
  if (currentAdapter instanceof DegradedDaemonPtyProvider) {
    currentAdapter.fanoutCurrentDaemonSyntheticExits(-1)
  }

  // Step 2: detach renderer listeners — after step 1 (so synthesized exits land) and before step 6 (no stale binding).
  unbindLocalProviderListeners()

  // Step 3: kill the current-protocol daemon process; legacy adapters untouched.
  let info: Awaited<ReturnType<DaemonSpawner['ensureRunning']>>
  try {
    await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)

    // Step 4: reuse the existing spawner so the respawn closure baked into long-lived adapters stays valid (do NOT new one).
    currentSpawner.resetHandle()
    info = await currentSpawner.ensureRunning()
  } catch (error) {
    // Why: old provider stays authoritative until the final swap; rebind since relaunch failed after teardown.
    rebindLocalProviderListeners()
    throw error
  }

  // Step 5: build a fresh current adapter against the respawned daemon.
  const newCurrent = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    pidPath: getDaemonPidPath(runtimeDir),
    profileScope: runtimeDir,
    runtimeDir,
    packagedAppVersion: resolvePackagedDarwinAppVersion(),
    historyPath: getHistoryDir(),
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
      currentSpawner.resetHandle()
      await currentSpawner.ensureRunning()
      return takeDaemonAdoptionLeaseRelease(currentSpawner.getHandle())
    }
  })
  let newProvider: DaemonProvider = newCurrent
  try {
    // Temporary launcher lease overlaps this permanent pair so a manual restart can't strand a newly spawned daemon during adoption.
    await newCurrent.establishLifecycleLease()
    releaseDaemonAdoptionLease(currentSpawner.getHandle())

    // Re-wrap in a router only if legacy adapters exist; they're preserved by reference and still route to their pre-upgrade daemons.
    newProvider =
      legacyAdapters.length > 0
        ? new DaemonPtyRouter({ current: newCurrent, legacy: legacyAdapters })
        : newCurrent
    if (newProvider instanceof DaemonPtyRouter) {
      await newProvider.discoverLegacySessions()
    }
  } catch (error) {
    let cleanupError: unknown
    try {
      if (newProvider instanceof DaemonPtyRouter) {
        newProvider.disposeRouterOnly()
      }
      await cleanupFailedDaemonAdoption(currentSpawner, newCurrent)
    } catch (caught) {
      cleanupError = caught
    }
    // Previous provider stays module-authoritative until the swap; restore its renderer bindings when adoption fails.
    rebindLocalProviderListeners()
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Daemon restart and cleanup both failed')
    }
    throw error
  }

  // Drain the old router's subscriptions via the router-only variant (plain dispose() would tear down the shared legacy adapters), after the new provider exists (no unhandled events) and before the swap (atomic for the renderer).
  disposeProviderSubscriptionsOnly(currentAdapter)

  // Step 6: swap module state (adapter + localProvider) atomically.
  replaceDaemonProvider(newProvider)

  // Step 7: rebind renderer listeners against the new provider.
  rebindLocalProviderListeners()

  return { killedCount }
}
