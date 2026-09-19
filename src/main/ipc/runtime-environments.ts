import { app, ipcMain } from 'electron'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentStatusOwner } from './runtime-environment-request-connections'
import type { Store } from '../persistence'
import {
  registerRuntimeEnvironmentConnectivityHandlers,
  registerRuntimeEnvironmentPassiveHandlers
} from './runtime-environment-connectivity-handlers'
import { closeRemoteRuntimeRequestConnection } from './runtime-environment-request-connections'
import { registerRuntimeEnvironmentRecoveryHandler } from './runtime-environment-recovery-handler'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { resetSharedControlSupport } from './runtime-environment-transport-routing'
import { RUNTIME_ENVIRONMENT_HANDLER_CHANNELS } from './runtime-environment-handler-channels'
import { retirePairedRuntimeBrowserClientHostEnvironment } from '../browser/paired-runtime-browser-client-host-runtime'
import { registerRuntimeEnvironmentBrowserClientHostHandler } from './runtime-environment-browser-client-host-handler'
import { registerOrcadRuntimeLifecycleHandlers } from './orcad-runtime-lifecycle-handlers'
import { registerRuntimeSshAccessHandlers } from './runtime-ssh-access-handlers'
import { advanceRuntimeEnvironmentCapabilityIncarnation } from './runtime-environment-capability-evidence'
import type { OrcadOutgoingRecoveryRuntime } from '../ssh/orcad-outgoing-recovery-selection'
import type { OrcadLiveMigrationContext } from '../ssh/orcad-live-migration-selection'
import { registerRuntimeEnvironmentReconciliationHandlers } from './runtime-environment-reconciliation-handlers'
import {
  closeSubscriptionsForEnvironment,
  registerRuntimeEnvironmentSubscriptions
} from './runtime-environment-subscriptions'

const getUserDataPath = (): string => app.getPath('userData')

/** Keeps historical grant-owned terminal/browser streams attached during catalog reconciliation. */
export function retireRuntimeEnvironmentControlTransport(environmentId: string): void {
  retireRuntimeEnvironmentTransports(environmentId, true)
}

function retireRuntimeEnvironmentTransports(
  environmentId: string,
  preserveResourceStreams: boolean
): void {
  advanceRuntimeEnvironmentCapabilityIncarnation(environmentId)
  advanceRuntimeEnvironmentTransportGeneration(environmentId)
  advanceRuntimeEnvironmentTransportGeneration(environmentId, 'resource')
  closeRemoteRuntimeRequestConnection(environmentId)
  closeSubscriptionsForEnvironment(
    environmentId,
    preserveResourceStreams ? { preserveResourceStreams: true } : undefined
  )
}

/** Returns once the environment's client-hosted browser pages have been released. */
export function invalidateRuntimeEnvironmentTransport(environmentId: string): Promise<void> {
  retireRuntimeEnvironmentTransports(environmentId, false)
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

export function registerRuntimeEnvironmentHandlers(
  store: Store,
  runtime?: OrcadOutgoingRecoveryRuntime,
  liveMigrationRuntime?: OrcadLiveMigrationContext['runtime']
): void {
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
  registerOrcadRuntimeLifecycleHandlers({
    runtime,
    ...(liveMigrationRuntime
      ? { liveMigrationContext: { store, runtime: liveMigrationRuntime } }
      : {}),
    getUserDataPath,
    getActiveEnvironmentId: () => store.getSettings().activeRuntimeEnvironmentId,
    invalidateTransport: invalidateRuntimeEnvironmentTransport
  })
  registerRuntimeEnvironmentSubscriptions(getUserDataPath)
  registerRuntimeEnvironmentReconciliationHandlers({
    getUserDataPath,
    retireControlTransport: retireRuntimeEnvironmentControlTransport
  })
}
