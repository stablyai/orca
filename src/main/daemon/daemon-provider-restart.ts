import {
  rebindLocalProviderListeners,
  unbindLocalProviderListeners
} from '../ipc/pty/provider/listener-lifecycle'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import {
  DaemonEndpointOwnershipError,
  cleanupFailedDaemonAdoption,
  releaseDaemonAdoptionLease,
  takeDaemonAdoptionLeaseRelease
} from './daemon-endpoint-adoption'
import {
  getDaemonHistoryDir as getHistoryDir,
  getDaemonRuntimeDir as getRuntimeDir
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
import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
import { cleanupDaemonForProtocol } from './daemon-protocol-cleanup'
import {
  isDaemonRestartInFlight,
  runCoalescedDaemonRestart,
  type RestartDaemonResult
} from './daemon-restart-state'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  type DaemonSpawner
} from './daemon-spawner'
import { DaemonClient } from './client'
import { endpointIsProvenDead, probeSocketConnect } from './daemon-endpoint-probe'
import { clearSeveredDaemon } from './daemon-host-image-state'
import { PROTOCOL_VERSION } from './types'
import { recoverRetiredMacDaemonJobs } from './macos-retired-daemon-recovery'

export type { RestartDaemonResult } from './daemon-restart-state'

// Restart only the current protocol, preserving legacy adapter instances.
export async function restartDaemon(
  options: {
    expectedDaemonPid?: number
    /** A retired daemon may already have left; only a different live owner aborts. */
    endpointMayBeGone?: boolean
  } = {}
): Promise<RestartDaemonResult> {
  return runCoalescedDaemonRestart(() =>
    runRestartDaemon(options.expectedDaemonPid, options.endpointMayBeGone === true)
  )
}

async function runRestartDaemon(
  expectedDaemonPid?: number,
  endpointMayBeGone = false
): Promise<RestartDaemonResult> {
  const currentSpawner = getDaemonSpawner()
  const currentAdapter = getDaemonProvider()
  if (!currentSpawner || !currentAdapter) {
    throw new Error('restartDaemon called before initDaemonPtyProvider')
  }

  const runtimeDir = getRuntimeDir()
  if (expectedDaemonPid === undefined) {
    // A wedged retired service must not prevent restarting the current daemon.
    await recoverRetiredMacDaemonJobs(runtimeDir).catch((error: unknown) => {
      console.warn(
        `[daemon] Retired macOS terminal service recovery failed: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }
  if (expectedDaemonPid !== undefined) {
    // Verify the target before teardown so a replacement daemon's terminals survive.
    await assertDaemonEndpointOwner(runtimeDir, expectedDaemonPid, endpointMayBeGone)
  }
  // Manual restart explicitly clears crash-loop containment so the UI can recover a wedged host.
  currentSpawner.resetRespawnWindow()
  const currentOnly = getCurrentDaemonAdapter(currentAdapter)
  // Retired generations cannot answer inventories; drop their routes.
  const legacyAdapters = getLegacyDaemonAdapters(currentAdapter).filter(
    (legacy) => !legacy.hasRetiredForIdle()
  )

  // Fan out exits before teardown: daemon shutdown does not deliver session exits to the renderer.
  const fallbackKilledCount =
    currentAdapter instanceof DegradedDaemonPtyProvider
      ? await currentAdapter.shutdownFallbackSessions()
      : 0
  const currentDaemonSessionIds =
    currentAdapter instanceof DegradedDaemonPtyProvider
      ? currentAdapter.getSessionIdsRoutedTo('current-daemon')
      : []
  const killedCount =
    new Set([...currentOnly.getActiveSessionIds(), ...currentDaemonSessionIds]).size +
    fallbackKilledCount
  currentOnly.fanoutSyntheticExits(-1, { replacedByRestart: true })
  if (currentAdapter instanceof DegradedDaemonPtyProvider) {
    currentAdapter.fanoutCurrentDaemonSyntheticExits(-1, { replacedByRestart: true })
  }

  // Unbind only after synthetic exits have reached renderer listeners.
  unbindLocalProviderListeners()

  let info: Awaited<ReturnType<DaemonSpawner['ensureRunning']>>
  try {
    await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION, expectedDaemonPid)

    // Reuse the spawner captured by long-lived respawn closures.
    currentSpawner.resetHandle()
    info = await currentSpawner.ensureRunning()
  } catch (error) {
    // The old provider remains authoritative until swap; restore its bindings when relaunch fails.
    rebindLocalProviderListeners()
    throw error
  }

  const newCurrent = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    pidPath: getDaemonPidPath(runtimeDir),
    profileScope: runtimeDir,
    runtimeDir,
    packagedAppVersion: currentSpawner.staleDaemonRecycleVersion,
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
      currentSpawner.resetHandle()
      await currentSpawner.ensureRunning()
      return takeDaemonAdoptionLeaseRelease(currentSpawner.getHandle())
    }
  })
  let newProvider: DaemonProvider = newCurrent
  try {
    // Overlap launcher and adapter leases to prevent a gap during restart adoption.
    await newCurrent.establishLifecycleLease()
    releaseDaemonAdoptionLease(currentSpawner.getHandle())

    // Preserve legacy adapter instances and newer-protocol holds on the new router.
    newProvider =
      legacyAdapters.length > 0 || isHoldingForNewerProtocolDaemon()
        ? new DaemonPtyRouter({
            current: newCurrent,
            legacy: legacyAdapters
          })
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
    // Adoption failed before swap; restore the old provider's renderer bindings.
    rebindLocalProviderListeners()
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Daemon restart and cleanup both failed')
    }
    throw error
  }

  // Dispose only old subscriptions after adoption; full disposal would kill shared legacy adapters.
  disposeProviderSubscriptionsOnly(currentAdapter)

  replaceDaemonProvider(newProvider)

  rebindLocalProviderListeners()
  clearSeveredDaemon()

  return { killedCount }
}

async function assertDaemonEndpointOwner(
  runtimeDir: string,
  expectedPid: number,
  endpointMayBeGone: boolean
): Promise<void> {
  const socketPath = getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION)
  // Only a proven-dead endpoint skips the check; a timeout or EPERM proves nothing.
  if (endpointMayBeGone && endpointIsProvenDead(await probeSocketConnect(socketPath))) {
    return
  }
  const client = new DaemonClient({
    socketPath,
    tokenPath: getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION)
  })
  try {
    await client.ensureConnected()
    if (client.getDaemonIdentity()?.pid !== expectedPid) {
      throw new DaemonEndpointOwnershipError(
        'Daemon restart aborted: the endpoint is owned by a different daemon than expected'
      )
    }
  } finally {
    client.disconnect()
  }
}
