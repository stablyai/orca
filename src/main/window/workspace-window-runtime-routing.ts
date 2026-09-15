import { app, ipcMain } from 'electron'
import {
  authorizeWorkspaceWindowEvent,
  getWorkspaceWindowNavigationId
} from './workspace-window-native-bridge'
import { getRuntimeEnvironmentStatus } from '../ipc/runtime-environment-transport-routing'
import { SESSION_WINDOW_NAVIGATION_CAPABILITY } from '../../shared/protocol-version'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environment-manual-disconnect'
import { runtimeEnvironmentRevisionFailure } from '../ipc/runtime-environment-revision-guard'

export const registerWorkspaceWindowRuntimeHandler: typeof ipcMain.handle = (channel, listener) => {
  ipcMain.handle(channel, listener)
  ipcMain.handle(`workspaceWindow:${channel}`, async (event, ...args) => {
    authorizeWorkspaceWindowEvent(event)
    const request = args[0] as
      | {
          selector?: string
          method?: string
          params?: unknown
          timeoutMs?: number
          expectedEnvironmentPairingRevision?: number
        }
      | undefined
    if (request?.method?.startsWith('session.window.')) {
      throw new Error('workspace_window_navigation_identity_unauthorized')
    }
    if (request?.method?.startsWith('session.tabs.')) {
      const environment = resolveEnvironment(app.getPath('userData'), request.selector!)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        throw new Error('runtime_manually_disconnected')
      }
      const revisionFailure = runtimeEnvironmentRevisionFailure(
        environment,
        request.expectedEnvironmentPairingRevision,
        request.method
      )
      if (revisionFailure && !revisionFailure.ok) {
        throw new Error(revisionFailure.error.message)
      }
      const status = await getRuntimeEnvironmentStatus(
        app.getPath('userData'),
        request.selector!,
        request.timeoutMs
      )
      if (
        !status.ok ||
        !status.result.capabilities?.includes(SESSION_WINDOW_NAVIGATION_CAPABILITY)
      ) {
        throw new Error('workspace_window_navigation_unsupported')
      }
      const windowId = getWorkspaceWindowNavigationId(event)
      args[0] = {
        ...request,
        method: request.method.replace('session.tabs.', 'session.window.tabs.'),
        params: { windowId, params: request.params }
      }
    }
    return listener(event, ...args)
  })
}
