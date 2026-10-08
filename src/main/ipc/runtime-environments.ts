import {
  registerRuntimeEnvironmentSubscriptionHandlers,
  type RetainedRemoteRuntimeSubscription,
  type PendingRuntimeSubscription
} from './runtime-environment-subscription-handlers'
import { app, ipcMain } from 'electron'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { Store } from '../persistence'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  registerRuntimeEnvironmentConnectivityHandlers,
  registerRuntimeEnvironmentPassiveHandlers
} from './runtime-environment-connectivity-handlers'
import {
  closeRemoteRuntimeRequestConnection,
  getRuntimeEnvironmentStatusOwner
} from './runtime-environment-request-connections'
import { registerRuntimeEnvironmentRecoveryHandler } from './runtime-environment-recovery-handler'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { resetSharedControlSupport } from './runtime-environment-transport-routing'
import { RUNTIME_ENVIRONMENT_HANDLER_CHANNELS } from './runtime-environment-handler-channels'
import { registerOrcadRuntimeLifecycleHandlers } from './orcad-runtime-lifecycle-handlers'
import { registerOrcadRuntimeConversionHandlers } from './orcad-runtime-conversion-handlers'
import { registerOrcadDeltaMoveHandlers } from './orcad-delta-move-handlers'
import { registerOrcadRuntimeMaintenanceHandlers } from './orcad-runtime-maintenance-handlers'
import { clearPublishedManagedServer } from './ssh-renderer-broadcast'
import { reconcileOrphanedRuntimeSessions } from './runtime-environment-session-reconcile'
import { registerRuntimeSshAccessHandlers } from './runtime-ssh-access-handlers'
import { retirePairedRuntimeBrowserClientHostEnvironment } from '../browser/paired-runtime-browser-client-host-runtime'
import { registerRuntimeEnvironmentBrowserClientHostHandler } from './runtime-environment-browser-client-host-handler'
import { advanceRuntimeEnvironmentCapabilityIncarnation } from './runtime-environment-capability-evidence'
import { retireMobileDesktopRelayEnvironment } from './runtime-environment-mobile-relay-hosts'
import { watchRuntimeEnvironmentPreference } from './runtime-environment-preference'

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
  registerRuntimeEnvironmentPassiveHandlers(getUserDataPath)
  for (const environment of listEnvironments(getUserDataPath())) {
    if (!isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
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
  registerOrcadRuntimeMaintenanceHandlers({
    getUserDataPath,
    getActiveEnvironmentId: () => store.getSettings().activeRuntimeEnvironmentId,
    invalidateTransport: invalidateRuntimeEnvironmentTransport,
    clearHostServerStatus: clearPublishedManagedServer,
    forgetHostSession: (hostId) => store.removeWorkspaceSessionHost(hostId)
  })
  registerRuntimeEnvironmentSubscriptionHandlers({
    getUserDataPath,
    remoteRuntimeSubscriptions,
    pendingSubscriptions
  })
}
