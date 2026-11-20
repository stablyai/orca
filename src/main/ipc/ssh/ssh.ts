import { awaitSshStartupReady, setSshStartupReady } from './ssh-startup-ready'
import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { SshConnectionStore } from '../../ssh/targets/ssh-connection-store'
import { resetLaunchReconnectOptOutsForTests } from './ssh-host-user-disconnect'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import { quitTeardownStartGate } from '../../startup/quit/quit-teardown-start-gate'
import {
  getSshTargetRegistryStore,
  setSshConnectionManagerResolver,
  setSshTargetMutations,
  setSshTargetRegistryHandlers,
  setSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import { registerSshBrowseHandler } from './ssh-browse'
import { submitCredential } from './ssh-passphrase'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { resetSshConnectionGenerations } from '../../ssh/connection/authority/ssh-connection-generation'
import { resetSshProviderAuthorities } from '../../ssh/connection/authority/ssh-provider-authority'
import {
  connectInFlight,
  credentialRequestedForTarget,
  testConnectionProbes,
  testingTargets
} from './ssh-connect-attempt-registry'
import { resetSshCredentialDeclinesForTests } from '../../ssh/authentication/ssh-credential-decline'
import { resetSshUserDisconnectsForTests } from '../../ssh/connection/ssh-user-disconnect'
import { registerPlainSshTerminalHandlers } from './plain-ssh-terminal-handlers'
import { unregisterPowerMonitorReconnect } from './ssh-host-sleep-reconnect'
import {
  connectionManager,
  portForwardManager,
  setConnectionManager,
  setCurrentRuntime,
  setPersistedStore,
  setPortForwardManager
} from './ssh-ipc-context'
import { resetSshShutdownDrain } from './ssh-shutdown-drain'
import { targetLifecycleInFlight } from './ssh-target-lifecycle-queue'
import { disposeOrcadManagedTunnels } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { registerLegacyRelayBridgeIpc } from '../../ssh/legacy-relay/bridge/legacy-relay-bridge-ipc'
import { installLegacyRelayBridgeApplication } from '../../ssh/legacy-relay/bridge/legacy-relay-bridge-application'
import {
  onLastBridgedTerminalExit,
  retryMoveAfterLastBridgedExit
} from '../../ssh/legacy-relay/bridge/legacy-relay-move-retry'
import {
  getSshHostServerStatus,
  isSshHostKeptForBridgedTerminals
} from '../../ssh/host-server/ssh-host-server-status'
import { connectTarget } from './ssh-connect-flow'
import {
  disposeDesktopBrowserBridge,
  installDesktopBrowserBridge
} from '../browser/desktop-browser-bridge-wiring'
import { SSH_APPLICATION_REQUESTS } from '../../ssh/application/ssh-application-requests'
import { startSshApplication } from '../../ssh/application/ssh-application'
import { setSshDesktopHost } from '../../ssh/application/ssh-desktop-host'
import { createElectronSshDesktopHost } from './ssh-electron-desktop-host'

let currentGetMainWindow: () => BrowserWindow | null = () => null

/** The desktop adapter: Electron IPC and native effects around the SSH application owner. */
export async function registerSshHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null,
  runtime?: OrcaRuntimeService,
  hostInitialization?: Promise<void>
): Promise<{ connectionManager: SshConnectionManager; sshStore: SshConnectionStore }> {
  // macOS window recreation re-registers handlers; remove old channels to avoid duplicate registration.
  for (const ch of SSH_APPLICATION_REQUESTS) {
    ipcMain.removeHandler(ch)
  }
  currentGetMainWindow = getMainWindow
  const getCurrentMainWindow = (): BrowserWindow | null => currentGetMainWindow()
  setSshDesktopHost(createElectronSshDesktopHost(getCurrentMainWindow))
  ipcMain.removeHandler('ssh:submitCredential')
  ipcMain.handle(
    'ssh:submitCredential',
    (_event, args: { requestId: string; value: string | null }) => submitCredential(args)
  )
  const started = startSshApplication({
    store,
    runtime,
    hostInitialization,
    register: (channel, operation) =>
      ipcMain.handle(channel, (_event, args: unknown) => operation(args)),
    beforeReady: () => {
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
    }
  })
  registerSshBrowseHandler(() => connectionManager)
  registerPlainSshTerminalHandlers((channel, listener) =>
    ipcMain.handle(channel, async (...args) => {
      await awaitSshStartupReady()
      return listener(...args)
    })
  )
  // COMPAT(legacy-relay-bridge): terminals an older Orca's relay still runs.
  registerLegacyRelayBridgeIpc({ runtime: () => runtime ?? null })

  const result = await started
  if (runtime) {
    installDesktopBrowserBridge({
      userDataPath: getAppEnvironment().getPath('userData'),
      runtime,
      getMainWindow: getCurrentMainWindow,
      getConnectionManager: () => connectionManager
    })
  }
  return result
}

export async function resetSshHandlerStateForTests(): Promise<void> {
  setSshStartupReady(Promise.resolve())
  unregisterPowerMonitorReconnect()
  for (const ch of SSH_APPLICATION_REQUESTS) {
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
  resetSshCredentialDeclinesForTests()
  resetSshUserDisconnectsForTests()
  resetLaunchReconnectOptOutsForTests()
  quitTeardownStartGate.resetForTests()
  resetSshShutdownDrain()

  disposeDesktopBrowserBridge()
  await connectionManager?.disconnectAll()
  disposeOrcadManagedTunnels()
  portForwardManager?.dispose()
  setConnectionManager(null)
  setSshConnectionManagerResolver(null)
  setPortForwardManager(null)
  setSshTargetRegistryStore(null)
  setPersistedStore(null)
  setSshTargetRegistryHandlers({ connect: null, getState: null })
  setSshTargetMutations(null)
  currentGetMainWindow = () => null
  setSshDesktopHost(null)
  setCurrentRuntime(undefined)
}

export function getSshConnectionStore(): SshConnectionStore | null {
  return getSshTargetRegistryStore()
}
