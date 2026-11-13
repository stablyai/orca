import { createAiVaultAssociationObserver } from '../ai-vault/ai-vault-projection-dependency'
import { invalidateAiVaultHostLegCache } from '../ai-vault/ai-vault-host-leg-cache'
import { registerRuntimeEnvironmentSubscriptionHandlers } from './subscriptions/runtime-environment-subscription-handlers'
import type {
  RetainedRemoteRuntimeSubscription,
  PendingRuntimeSubscription
} from './subscriptions/runtime-environment-subscription-setup'
import { ipcMain } from 'electron'
import { getRuntimeEnvironmentRegistryRoot } from './catalog/runtime-environment-registry-root'
import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import type { Store } from '../../persistence/loading-store/store'
import { recordRemoteLayoutFrame } from '../../remote-layout-snapshot/remote-layout-snapshot-recorder'
import { recordHostRepoCatalogAnswer } from '../../host-repo-catalog-snapshot/host-repo-catalog-snapshot-recorder'
import {
  registerRuntimeEnvironmentConnectivityHandlers,
  registerRuntimeEnvironmentPassiveHandlers
} from './connectivity/runtime-environment-connectivity-handlers'
import { isRuntimeEnvironmentManuallyDisconnected } from './connectivity/runtime-environment-manual-disconnect'
import {
  closeRemoteRuntimeRequestConnection,
  getRuntimeEnvironmentStatusOwner
} from './connections/runtime-environment-request-connections'
import { setRefusedPairingHandlers } from './pairing/runtime-environment-pairing-refusal-registry'
import {
  handleManagedSharedControlRefusal,
  recoverRefusedManagedPairing
} from './pairing/runtime-environment-managed-pairing-refusal'
import { setManagedOrcadPairingRepairedListener } from '../../managed-server/lifecycle/orcad-managed-pairing-repaired-listener'
import { forgetManagedOrcadAutomaticFailures } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { registerRuntimeEnvironmentRecoveryHandler } from './connectivity/runtime-environment-recovery-handler'
import { registerRuntimeEnvironmentRepairHandler } from './pairing/runtime-environment-repair-handler'
import {
  advanceRuntimeEnvironmentTransportGeneration,
  onRuntimeEnvironmentTransportGenerationRetired
} from './connections/runtime-environment-transport-generation'
import { resetSharedControlSupport } from './connections/runtime-environment-shared-control-support'
import { RUNTIME_ENVIRONMENT_HANDLER_CHANNELS } from './runtime-environment-handler-channels'
import { registerOrcadRuntimeLifecycleHandlers } from './managed-orcad/orcad-runtime-lifecycle-handlers'
import { registerOrcadRuntimeConversionHandlers } from './managed-orcad/orcad-runtime-conversion-handlers'
import { registerOrcadDeltaMoveHandlers } from './managed-orcad/orcad-delta-move-handlers'
import { registerOrcadLeaveBehindHandlers } from './managed-orcad/orcad-leave-behind-handlers'
import { registerOrcadRuntimeMaintenanceHandlers } from './managed-orcad/orcad-runtime-maintenance-handlers'
import { clearPublishedManagedServer } from '../ssh/ssh-renderer-broadcast'
import { clearManagedServerNotes } from './managed-orcad/runtime-environment-managed-tunnel'
import { reconcileOrphanedRuntimeSessions } from './catalog/runtime-environment-session-reconcile'
import { registerRuntimeSshAccessHandlers } from '../runtime-ssh-access-handlers'
import { retirePairedRuntimeBrowserClientHostEnvironment } from '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { registerRuntimeEnvironmentBrowserClientHostHandler } from './browser-hosting/runtime-environment-browser-client-host-handler'
import { advanceRuntimeEnvironmentCapabilityIncarnation } from './connections/runtime-environment-capability-evidence'
import { retireMobileDesktopRelayEnvironment } from './mobile-relay/runtime-environment-mobile-relay-hosts'
import { watchRuntimeEnvironmentPreference } from './catalog/runtime-environment-preference'
import { publishRuntimeEnvironmentCatalogChanged } from './catalog/runtime-environment-catalog-broadcast'
import { isGatedOffWslHost } from '../../wsl/host-lifecycle/wsl-host-gate'
import { resetDesktopBrowserBridgeEnvironment } from '../browser/desktop-browser-bridge-reconcile'

const remoteRuntimeSubscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()
const getUserDataPath = getRuntimeEnvironmentRegistryRoot

function closeSubscriptionsForEnvironment(environmentId: string): void {
  for (const pending of pendingSubscriptions.values()) {
    if (pending.environmentId === environmentId) {
      pending.close()
    }
  }
  closeEstablishedSubscriptionsForEnvironment(environmentId)
}

function closeEstablishedSubscriptionsForEnvironment(environmentId: string): number {
  let closed = 0
  // Removed runtimes must release terminal/browser sockets before renderer teardown.
  for (const [subscriptionId, subscription] of remoteRuntimeSubscriptions) {
    if (subscription.environmentId !== environmentId) {
      continue
    }
    closed += 1
    remoteRuntimeSubscriptions.delete(subscriptionId)
    // Isolate close and notification failures so neither strands this environment's sibling subscriptions.
    try {
      subscription.close()
    } catch (error) {
      console.warn('[runtime-environments] subscription close failed during retirement:', error)
    }
    try {
      // Shared-control logical close does not call back.
      subscription.notifyClosed()
    } catch (error) {
      console.warn('[runtime-environments] subscription close notice failed:', error)
    }
  }
  return closed
}
// A retired generation's frames are discarded (runtime-environment-subscription-handlers.ts), so its
// streams must close and tell their renderers, which resubscribe from where they left off. Streams
// still being set up fail their own generation check instead.
onRuntimeEnvironmentTransportGenerationRetired((environmentId) => {
  const closed = closeEstablishedSubscriptionsForEnvironment(environmentId)
  if (closed > 0) {
    console.warn(`[runtime-environments] transport retired; reopening ${closed} stream(s)`, {
      environmentId
    })
  }
})

/** Returns once the environment's client-hosted browser pages have been released. */
export function invalidateRuntimeEnvironmentTransport(environmentId: string): Promise<void> {
  // Same-ID re-pairing must retire every transport authenticated as the former peer.
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

/** CLI update/rollback re-pairing needs a new status owner to publish the saved revision to renderers. */
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
  stopPreferenceWatch = watchRuntimeEnvironmentPreference(store, getUserDataPath(), () => {
    // CLI and recipe removals skip the Settings path; drop their session partitions here too.
    try {
      reconcileOrphanedRuntimeSessions(store, getUserDataPath())
    } catch (error) {
      console.warn('[runtime-environments] orphaned session reconcile failed:', error)
    }
    publishRuntimeEnvironmentCatalogChanged()
  })
  for (const pending of pendingSubscriptions.values()) {
    pending.close()
  }
  pendingSubscriptions.clear()
  // Direct re-registration must not accumulate binary-send listeners.
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
  registerRuntimeEnvironmentPassiveHandlers(getUserDataPath, (environment, method, response) =>
    recordHostRepoCatalogAnswer(store, environment, method, response)
  )
  setManagedOrcadPairingRepairedListener(invalidateRuntimeEnvironmentTransport)
  setRefusedPairingHandlers({
    recover: (environmentId) => recoverRefusedManagedPairing(getUserDataPath(), environmentId),
    sharedControl: (environmentId) =>
      handleManagedSharedControlRefusal(getUserDataPath(), environmentId),
    connectRequested: (environmentId) =>
      forgetManagedOrcadAutomaticFailures(getUserDataPath(), environmentId)
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
    createAssociationObserver: (environmentId, identity) =>
      createAiVaultAssociationObserver(environmentId, identity, invalidateAiVaultHostLegCache),
    getUserDataPath,
    remoteRuntimeSubscriptions,
    pendingSubscriptions,
    recordLayoutFrame: (environmentId, method, response) =>
      recordRemoteLayoutFrame(store, environmentId, method, response)
  })
}
