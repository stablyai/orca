
import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { SshConnectionManager } from '../ssh/ssh-connection-manager'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import {
  getSshTargetRegistryStore,
  setSshConnectionManagerResolver,
  setSshTargetRegistryHandlers,
  setSshTargetRegistryStore
} from '../ssh/ssh-target-registry'

// Why re-exported: the registry moved to ../ssh/ssh-target-registry so the runtime can
// read it without pulling ipcMain in, but many existing importers reference these from
// here. Re-exporting keeps them working without a repo-wide rename.
export {
  connectRegisteredSshTarget,
  getActiveMultiplexer,
  getRegisteredSshState,
  getSshConnectionManager,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSshTargets
} from '../ssh/ssh-target-registry'
import { registerSshBrowseHandler } from './ssh-browse'
import { registerCredentialHandler } from './ssh-passphrase'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  initializeSshConnectionGenerationSession,
  resetSshConnectionGenerations
} from '../ssh/ssh-connection-generation'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { installManagedOrcadStartStatus } from './runtime-environment-managed-tunnel'
import { connectInFlight, credentialRequestedForTarget, testConnectionProbes, testingTargets } from './ssh-connect-attempt-registry'
import { createSshConnectionCallbacks } from './ssh-connection-state-callbacks'
import { registerSshConnectionHandlers } from './ssh-connection-handlers'
import {
  registerPowerMonitorReconnect,
  unregisterPowerMonitorReconnect
} from './ssh-host-sleep-reconnect'
import {
  connectionManager,
  getCurrentMainWindow,
  portForwardManager,
  setConnectionManager,
  setCurrentGetMainWindow,
  setCurrentRuntime,
  setPersistedStore,
  setPortForwardManager
} from './ssh-ipc-context'
import { registerSshPortForwardHandlers } from './ssh-port-forward-handlers'
import { persistPortForwardsWithUnrestored } from './ssh-port-forward-persistence'
import { broadcastPortForwards } from './ssh-renderer-broadcast'
import { resetSshShutdownDrain } from './ssh-shutdown-drain'
import { registerSshTargetCrudHandlers } from './ssh-target-crud-handlers'
import { targetLifecycleInFlight } from './ssh-target-lifecycle-queue'
import { disposeOrcadManagedTunnels } from '../ssh/orcad-managed-tunnel'
import { reconcileManagedOrcadSshTargets } from '../ssh/orcad-retained-source'
import { installOrcadMigrationScrollbackRetention } from '../ssh/orcad-migration-scrollback-retention-wiring'
import { getAppEnvironment } from '../../shared/app-environment'

const SSH_IPC_CHANNELS = [
  'ssh:listTargets',
  'ssh:listRemovedTargetLabels',
  'ssh:addTarget',
  'ssh:updateTarget',
  'ssh:removeTarget',
  'ssh:importConfig',
  'ssh:listConfigHosts',
  'ssh:resolveConfigHost',
  'ssh:connect',
  'ssh:disconnect',
  'ssh:getState',
  'ssh:needsPassphrasePrompt',
  'ssh:testConnection',
  'ssh:addPortForward',
  'ssh:updatePortForward',
  'ssh:removePortForward',
  'ssh:listPortForwards',
  'ssh:listDetectedPorts'
] as const

export function registerSshHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null,
  runtime?: OrcaRuntimeService
): { connectionManager: SshConnectionManager; sshStore: SshConnectionStore } {
  initializeSshConnectionGenerationSession()
  // Why: macOS re-activation re-calls this with a new BrowserWindow; ipcMain.handle() throws on a duplicate channel, so remove prior handlers first.
  for (const ch of SSH_IPC_CHANNELS) {
    ipcMain.removeHandler(ch)
  }

  setCurrentGetMainWindow(getMainWindow)
  setCurrentRuntime(runtime)
  setSshTargetRegistryStore(new SshConnectionStore(store))
  setPersistedStore(store)
  reconcileManagedOrcadSshTargets(getAppEnvironment().getPath('userData'), store)
  installOrcadMigrationScrollbackRetention(getAppEnvironment().getPath('userData'), store)
  installManagedOrcadStartStatus()

  registerCredentialHandler()

  const callbacks = createSshConnectionCallbacks()
  if (connectionManager) {
    connectionManager.setCallbacks(callbacks)
  } else {
    setConnectionManager(new SshConnectionManager(callbacks))
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
      }
      persistPortForwardsWithUnrestored(entry.connectionId)
      broadcastPortForwards(getCurrentMainWindow, entry.connectionId)
    }
  })
  registerPowerMonitorReconnect(() => getAppEnvironment().getPath('userData'))
  registerSshBrowseHandler(() => connectionManager)
  setSshConnectionManagerResolver(() => connectionManager)

  registerSshTargetCrudHandlers()
  registerSshConnectionHandlers()
  registerSshPortForwardHandlers()

  return {
    connectionManager: connectionManager!,
    sshStore: getSshTargetRegistryStore() as SshConnectionStore
  }
}

export async function resetSshHandlerStateForTests(): Promise<void> {
  unregisterPowerMonitorReconnect()
  for (const ch of SSH_IPC_CHANNELS) {
    ipcMain.removeHandler(ch)
  }
  ipcMain.removeHandler('ssh:submitCredential')

  connectInFlight.clear()
  targetLifecycleInFlight.clear()
  resetSshConnectionGenerations()
  resetSshProviderAuthorities()
  testingTargets.clear()
  testConnectionProbes.clear()
  credentialRequestedForTarget.clear()
  quitTeardownStartGate.resetForTests()
  resetSshShutdownDrain()

  await connectionManager?.disconnectAll()
  disposeOrcadManagedTunnels()
  portForwardManager?.dispose()
  setConnectionManager(null)
  setSshConnectionManagerResolver(null)
  setPortForwardManager(null)
  setSshTargetRegistryStore(null)
  setPersistedStore(null)
  setSshTargetRegistryHandlers({ connect: null, getState: null })
  setCurrentGetMainWindow(() => null)
  setCurrentRuntime(undefined)
}

export function getSshConnectionStore(): SshConnectionStore | null {
  return getSshTargetRegistryStore()
}
