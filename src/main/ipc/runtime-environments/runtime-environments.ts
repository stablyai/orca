import {
  registerRuntimeEnvironmentSubscriptionHandlers,
  type RetainedRemoteRuntimeSubscription,
  type PendingRuntimeSubscription
} from './runtime-environment-subscription-handlers'
import { app, ipcMain } from 'electron'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import type { Store } from '../../persistence'
import { recordRemoteLayoutFrame } from '../../remote-layout-snapshot/remote-layout-snapshot-recorder'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  registerRuntimeEnvironmentConnectivityHandlers,
  registerRuntimeEnvironmentPassiveHandlers
} from './runtime-environment-connectivity-handlers'
import {
  closeRemoteRuntimeRequestConnection,
  getRuntimeEnvironmentStatusOwner
} from './runtime-environment-request-connections'
import { setRefusedPairingHandlers } from './runtime-environment-pairing-refusal-registry'
import {
  handleManagedSharedControlRefusal,
  recoverRefusedManagedPairing
} from './runtime-environment-managed-pairing-refusal'
import { setManagedOrcadPairingRepairedListener } from '../../managed-server/lifecycle/orcad-managed-pairing-repaired-listener'
import { forgetFailedManagedOrcadPairingRepair } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { registerRuntimeEnvironmentRecoveryHandler } from './runtime-environment-recovery-handler'
import { registerRuntimeEnvironmentRepairHandler } from './runtime-environment-repair-handler'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { resetSharedControlSupport } from './runtime-environment-shared-control-support'
import { RUNTIME_ENVIRONMENT_HANDLER_CHANNELS } from './runtime-environment-handler-channels'
import { registerOrcadRuntimeLifecycleHandlers } from './orcad-runtime-lifecycle-handlers'
import { registerOrcadRuntimeConversionHandlers } from './orcad-runtime-conversion-handlers'
import { registerOrcadDeltaMoveHandlers } from './orcad-delta-move-handlers'
import { registerOrcadLeaveBehindHandlers } from './orcad-leave-behind-handlers'
import { registerOrcadRuntimeMaintenanceHandlers } from './orcad-runtime-maintenance-handlers'
import { clearPublishedManagedServer } from '../ssh/ssh-renderer-broadcast'
import { clearManagedServerNotes } from './runtime-environment-managed-tunnel'
import { reconcileOrphanedRuntimeSessions } from './runtime-environment-session-reconcile'
import { registerRuntimeSshAccessHandlers } from '../runtime-ssh-access-handlers'
import { retirePairedRuntimeBrowserClientHostEnvironment } from '../../browser/paired-runtime-browser-client-host-runtime'
import { registerRuntimeEnvironmentBrowserClientHostHandler } from './runtime-environment-browser-client-host-handler'
import { advanceRuntimeEnvironmentCapabilityIncarnation } from './runtime-environment-capability-evidence'
import { retireMobileDesktopRelayEnvironment } from './runtime-environment-mobile-relay-hosts'
import { watchRuntimeEnvironmentPreference } from './runtime-environment-preference'
import { isGatedOffWslHost } from '../../wsl/wsl-host-gate'
import { resetDesktopBrowserBridgeEnvironment } from '../desktop-browser-bridge-reconcile'

const remoteRuntimeSubscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()
const getUserDataPath = (): string => app.getPath('userData')

function closeSubscriptionsForEnvironment(environmentId: string): void {
  for (const pending of pendingSubscriptions.values()) {
    if (pending.environmentId === environmentId) {
      pending.close()
    }
  }
  // Why: removed runtimes must not retain terminal/browser WebSockets until renderer teardown.
  for (const [subscriptionId, subscription] of remoteRuntimeSubscriptions) {
    if (subscription.environmentId !== environmentId) {
      continue
    }
    remoteRuntimeSubscriptions.delete(subscriptionId)
    // Why: one failing teardown must not abandon this environment's other
    // sockets -- that strands exactly the dead handles this sweep exists to
    // retire. Guard the two steps independently so neither can skip the other,
    // and so the isolation stays structural rather than resting on a claim that
    // nothing inside notifyClosed will ever throw.
    try {
      subscription.close()
    } catch (error) {
      console.warn('[runtime-environments] subscription close failed during retirement:', error)
    }
    try {
      // Why: a shared-control logical close never calls back, so notify directly.
      subscription.notifyClosed()
    } catch (error) {
      console.warn('[runtime-environments] subscription close notice failed:', error)
    }
  }
}
/** Returns once the environment's client-hosted browser pages have been released. */
export function invalidateRuntimeEnvironmentTransport(environmentId: string): Promise<void> {
  // Why: a same-id re-pair must retire every transport that still authenticates as the old peer.
  advanceRuntimeEnvironmentCapabilityIncarnation(environmentId)
  advanceRuntimeEnvironmentTransportGeneration(environmentId)
  closeRemoteRuntimeRequestConnection(environmentId)
  closeSubscriptionsForEnvironment(environmentId)
  retireMobileDesktopRelayEnvironment(environmentId)
  resetDesktopBrowserBridgeEnvironment(environmentId)
  reactivateRuntimeEnvironmentStatus(environmentId)
  return retirePairedRuntimeBrowserClientHostEnvironment(
    environmentId,
    new Error('Runtime environment transport was invalidated')
  ).then(
    () => undefined,
    (error) => {
      console.warn('[runtime-environments] browser client host retirement failed:', error)
    }
  )
}

/**
 * A re-pair main ran (an update or rollback from the CLI) reaches renderers only through status
 * published under the new revision; without an owner nothing publishes it (P1-C).
 */
function reactivateRuntimeEnvironmentStatus(environmentId: string): void {
  const userDataPath = getUserDataPath()
  if (
    isRuntimeEnvironmentManuallyDisconnected(environmentId) ||
    !listEnvironments(userDataPath).some(
      (environment) => environment.id === environmentId && !isGatedOffWslHost(environment)
    )
  ) {
    return
  }
  getRuntimeEnvironmentStatusOwner(userDataPath, environmentId).activate()
}

const pendingSubscriptions = new Map<string, PendingRuntimeSubscription>()
let stopPreferenceWatch: (() => void) | undefined

export function registerRuntimeEnvironmentHandlers(store: Store): void {
  stopPreferenceWatch?.()
  stopPreferenceWatch = watchRuntimeEnvironmentPreference(store, getUserDataPath())
  for (const pending of pendingSubscriptions.values()) {
    pending.close()
  }
  pendingSubscriptions.clear()
  // Why: keep direct re-registration safe even though register-core-handlers
  // normally guards this path; otherwise the binary send listener can stack.
  resetSharedControlSupport()
  for (const channel of RUNTIME_ENVIRONMENT_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeAllListeners('runtimeEnvironments:subscriptionBinary')
  reconcileOrphanedRuntimeSessions(store, getUserDataPath())

  registerRuntimeEnvironmentConnectivityHandlers({
    store,
    getUserDataPath,
    invalidateTransport: invalidateRuntimeEnvironmentTransport
  })
  registerRuntimeEnvironmentBrowserClientHostHandler({
    getUserDataPath,
    getSettings: () => store.getSettings()
  })
  registerRuntimeEnvironmentRecoveryHandler()
  registerRuntimeEnvironmentRepairHandler({
    getUserDataPath,
    invalidateTransport: invalidateRuntimeEnvironmentTransport
  })
  registerRuntimeEnvironmentPassiveHandlers(getUserDataPath)
  setManagedOrcadPairingRepairedListener(invalidateRuntimeEnvironmentTransport)
  setRefusedPairingHandlers({
    recover: (environmentId) => recoverRefusedManagedPairing(getUserDataPath(), environmentId),
    sharedControl: (environmentId) =>
      handleManagedSharedControlRefusal(getUserDataPath(), environmentId),
    connectRequested: (environmentId) =>
      forgetFailedManagedOrcadPairingRepair(getUserDataPath(), environmentId)
  })
  for (const environment of listEnvironments(getUserDataPath())) {
    if (
      !isRuntimeEnvironmentManuallyDisconnected(environment.id) &&
      !isGatedOffWslHost(environment)
    ) {
      getRuntimeEnvironmentStatusOwner(getUserDataPath(), environment.id).activate()
    }
  }
  registerRuntimeSshAccessHandlers({
    getUserDataPath,
    invalidateTransport: invalidateRuntimeEnvironmentTransport
  })
  registerOrcadRuntimeLifecycleHandlers({ getUserDataPath })
  registerOrcadRuntimeConversionHandlers(getUserDataPath)
  registerOrcadDeltaMoveHandlers(getUserDataPath)
  registerOrcadLeaveBehindHandlers()
  registerOrcadRuntimeMaintenanceHandlers({
    getUserDataPath,
    getActiveEnvironmentId: () => store.getSettings().activeRuntimeEnvironmentId,
    invalidateTransport: invalidateRuntimeEnvironmentTransport,
    clearHostServerStatus: clearPublishedManagedServer,
    clearHostServerNotes: clearManagedServerNotes,
    store
  })
  registerRuntimeEnvironmentSubscriptionHandlers({
    getUserDataPath,
    remoteRuntimeSubscriptions,
    pendingSubscriptions,
    recordLayoutFrame: (environmentId, method, response) =>
      recordRemoteLayoutFrame(store, environmentId, method, response)
  })
}
