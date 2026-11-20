import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { SshConnectionStore } from '../targets/ssh-connection-store'
import { SshConnectionManager } from '../connection/ssh-connection-manager'
import { SshPortForwardManager } from '../port-forwarding/ssh-port-forward'
import {
  getSshTargetRegistryStore,
  setSshConnectionManagerResolver,
  setSshTargetRegistryStore
} from '../targets/ssh-target-registry'
import { initializeSshConnectionGenerationSession } from '../connection/authority/ssh-connection-generation'
import {
  getSshHostServerStatus,
  isSshHostKeptForBridgedTerminals,
  setSshHostServedListener
} from '../host-server/ssh-host-server-status'
import {
  onLastBridgedTerminalExit,
  retryMoveAfterLastBridgedExit
} from '../legacy-relay/bridge/legacy-relay-move-retry'
import { installLegacyRelayBridgeApplication } from '../legacy-relay/bridge/legacy-relay-bridge-application'
import { setSshStartupReady } from '../../ipc/ssh/ssh-startup-ready'
import { awaitSignInForCredentialHosts } from '../../ipc/ssh/ssh-sign-in-requirement'
import { holdLaunchReconnectOptOuts } from '../../ipc/ssh/ssh-host-user-disconnect'
import { createSshConnectionCallbacks } from '../../ipc/ssh/ssh-connection-state-callbacks'
import { registerPowerMonitorReconnect } from '../../ipc/ssh/ssh-host-sleep-reconnect'
import {
  connectionManager,
  portForwardManager,
  setConnectionManager,
  setCurrentRuntime,
  setPersistedStore,
  setPortForwardManager
} from '../../ipc/ssh/ssh-ipc-context'
import { persistPortForwards } from '../../ipc/ssh/ssh-port-forward-persistence'
import { recordForwardFailure } from '../../ipc/ssh/ssh-port-forward-unrestored'
import { restoreManagedHostPortForwards } from '../../ipc/ssh/ssh-managed-port-forward-restore'
import { broadcastPortForwards } from '../../ipc/ssh/ssh-renderer-broadcast'
import { registerSshTargetCrudHandlers } from '../../ipc/ssh/ssh-target-crud-handlers'
import { registerSshConnectionHandlers } from '../../ipc/ssh/ssh-connection-handlers'
import { registerSshPortForwardHandlers } from '../../ipc/ssh/ssh-port-forward-handlers'
import { connectInFlight } from '../../ipc/ssh/ssh-connect-attempt-registry'
import { connectTarget } from '../../ipc/ssh/ssh-connect-flow'
import { installManagedOrcadStartStatus } from '../../ipc/runtime-environments/managed-orcad/runtime-environment-managed-tunnel'
import { retainUnretainedOrcadMigrationSources } from '../../persistence/migrating-orcad-catalog/retained-source/orcad-migration-source-retention'
import { reconcileManagedOrcadSshTargets } from '../../persistence/migrating-orcad-catalog/retained-source/orcad-retained-source'
import { installOrcadMigrationScrollbackRetention } from '../../persistence/migrating-orcad-catalog/terminal-history/orcad-migration-scrollback-retention-wiring'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import type { RegisterSshRequest } from './ssh-application-requests'

/**
 * The single SSH target/connection/forward/relay owner. Native effects come from the installed
 * SshDesktopHost; renderer requests reach it through `register`, gated on startup reconciliation.
 * Re-running it (macOS window recreation) rebinds the same managers rather than replacing them.
 */
export async function startSshApplication({
  store,
  runtime,
  hostInitialization,
  register
}: {
  store: Store
  runtime?: OrcaRuntimeService
  hostInitialization?: Promise<void>
  register: RegisterSshRequest
}): Promise<{ connectionManager: SshConnectionManager; sshStore: SshConnectionStore }> {
  initializeSshConnectionGenerationSession()
  setCurrentRuntime(runtime)
  setSshTargetRegistryStore(new SshConnectionStore(store))
  setPersistedStore(store)
  const ready = (async () => {
    await hostInitialization
    await holdLaunchReconnectOptOuts(getSshTargetRegistryStore()!.listTargets())
    await reconcileManagedOrcadSshTargets(getAppEnvironment().getPath('userData'), store)
  })()
  setSshStartupReady(ready)
  const handle: RegisterSshRequest = (channel, operation) =>
    register(channel, async (args) => {
      await ready
      return operation(args)
    })

  const callbacks = createSshConnectionCallbacks()
  if (connectionManager) {
    connectionManager.setCallbacks(callbacks)
  } else {
    setConnectionManager(new SshConnectionManager(callbacks))
    // Window re-registration must not re-gate hosts already signed in during this process.
    awaitSignInForCredentialHosts(getSshTargetRegistryStore()!)
  }
  setPortForwardManager(portForwardManager ?? new SshPortForwardManager())
  portForwardManager!.setCallbacks({
    onForwardClosed: (entry, reason) => {
      if (reason.kind === 'unexpected-exit') {
        console.warn(
          `[ssh] Port forward ${entry.localPort} → ${entry.remoteHost}:${entry.remotePort} closed unexpectedly${
            reason.detail ? `: ${reason.detail}` : ''
          }`
        )
        // An ssh that starts and later dies backs off like one that never started.
        recordForwardFailure(
          entry.connectionId,
          entry,
          reason.detail ?? 'exited unexpectedly',
          'exit'
        )
      }
      persistPortForwards(entry.connectionId)
      broadcastPortForwards(entry.connectionId)
    }
  })
  // Every served status restores saved forwards, whichever path brought the host up.
  setSshHostServedListener((targetId) => void restoreManagedHostPortForwards(targetId))
  registerPowerMonitorReconnect(() => getAppEnvironment().getPath('userData'))
  setSshConnectionManagerResolver(() => connectionManager)

  registerSshTargetCrudHandlers(handle)
  registerSshConnectionHandlers(handle)
  registerSshPortForwardHandlers(handle)
  // COMPAT(legacy-relay-bridge): terminals an older Orca's relay still runs.
  installLegacyRelayBridgeApplication({
    store,
    connection: (targetId) => connectionManager?.getConnection(targetId) ?? null,
    runtime: () => runtime ?? null
  })
  // COMPAT(legacy-relay-bridge): the move waited only on those terminals; finish it (#29626).
  onLastBridgedTerminalExit(
    (targetId) =>
      void retryMoveAfterLastBridgedExit(targetId, {
        waitingOnBridgedTerminals: (id) =>
          connectionManager?.getState(id)?.status === 'connected' &&
          isSshHostKeptForBridgedTerminals(getSshHostServerStatus(id)),
        connectInFlight: (id) => connectInFlight.get(id)?.promise,
        connect: (id) => connectTarget(id, { quiet: true })
      })
  )

  await ready
  void retainUnretainedOrcadMigrationSources(getAppEnvironment().getPath('userData'), store)
  installOrcadMigrationScrollbackRetention(getAppEnvironment().getPath('userData'), store)
  installManagedOrcadStartStatus()
  return {
    connectionManager: connectionManager!,
    sshStore: getSshTargetRegistryStore() as SshConnectionStore
  }
}
