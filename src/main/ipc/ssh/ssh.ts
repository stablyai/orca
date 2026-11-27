import { awaitSshStartupReady } from './ssh-startup-ready'
import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { SshConnectionStore } from '../../ssh/targets/ssh-connection-store'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { registerSshBrowseHandler } from './ssh-browse'
import { submitCredential } from './ssh-passphrase'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { connectInFlight } from './ssh-connect-attempt-registry'
import { registerPlainSshTerminalHandlers } from './plain-ssh-terminal-handlers'
import { connectionManager } from './ssh-ipc-context'
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
import { installDesktopBrowserBridge } from '../browser/desktop-browser-bridge-wiring'
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

export function getSshConnectionStore(): SshConnectionStore | null {
  return getSshTargetRegistryStore()
}
