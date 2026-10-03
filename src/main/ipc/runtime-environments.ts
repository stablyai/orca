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
import {
  closeSubscriptionsForEnvironment,
  registerRuntimeEnvironmentSubscriptions
} from './runtime-environment-subscriptions'
import { RUNTIME_ENVIRONMENT_HANDLER_CHANNELS } from './runtime-environment-handler-channels'
import { registerOrcadRuntimeLifecycleHandlers } from './orcad-runtime-lifecycle-handlers'
import { registerOrcadRuntimeConversionHandlers } from './orcad-runtime-conversion-handlers'
import { registerOrcadRuntimeMaintenanceHandlers } from './orcad-runtime-maintenance-handlers'
import { registerRuntimeSshAccessHandlers } from './runtime-ssh-access-handlers'
import { retirePairedRuntimeBrowserClientHostEnvironment } from '../browser/paired-runtime-browser-client-host-runtime'
import { registerRuntimeEnvironmentBrowserClientHostHandler } from './runtime-environment-browser-client-host-handler'
import { advanceRuntimeEnvironmentCapabilityIncarnation } from './runtime-environment-capability-evidence'

const getUserDataPath = (): string => app.getPath('userData')

/** Returns once the environment's client-hosted browser pages have been released. */
export function invalidateRuntimeEnvironmentTransport(environmentId: string): Promise<void> {
  // Why: a same-id re-pair must retire every transport that still authenticates as the old peer.
  advanceRuntimeEnvironmentCapabilityIncarnation(environmentId)
  advanceRuntimeEnvironmentTransportGeneration(environmentId)
  closeRemoteRuntimeRequestConnection(environmentId)
  closeSubscriptionsForEnvironment(environmentId)
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

export function registerRuntimeEnvironmentHandlers(store: Store): void {
  // Why: keep direct re-registration safe even though register-core-handlers
  // normally guards this path; otherwise the binary send listener can stack.
  resetSharedControlSupport()
  for (const channel of RUNTIME_ENVIRONMENT_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeAllListeners('runtimeEnvironments:subscriptionBinary')

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
  registerOrcadRuntimeMaintenanceHandlers({
    getUserDataPath,
    getActiveEnvironmentId: () => store.getSettings().activeRuntimeEnvironmentId,
    invalidateTransport: invalidateRuntimeEnvironmentTransport
  })
  registerRuntimeEnvironmentSubscriptions(getUserDataPath)
}
