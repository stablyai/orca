import { ipcMain } from 'electron'
import { authorizeWorkspaceWindowEvent } from './workspace-window-native-bridge'
import type { ShellPathScope, ShellRuntimeScope } from '../../preload/api/shell-api'
import type { Store } from '../persistence'

export function createWorkspaceWindowShellScope(store: Store, getRuntimeId: () => string | null) {
  const hasActiveRuntime = (): boolean =>
    Boolean(store.getSettings().activeRuntimeEnvironmentId?.trim())
  const remoteRuntime = (scope: ShellRuntimeScope | undefined): boolean => {
    if (scope && typeof scope === 'object') {
      return remotePath(scope)
    }
    return scope === undefined ? hasActiveRuntime() : !scope || scope !== getRuntimeId()
  }
  const remotePath = (scope?: ShellPathScope): boolean =>
    scope?.kind === 'local-artifact'
      ? false
      : scope?.kind === 'workspace'
        ? Boolean(scope.connectionId) || remoteRuntime(scope.runtimeId)
        : hasActiveRuntime()
  return { remoteRuntime, remotePath }
}

export const registerWorkspaceWindowShellHandler: typeof ipcMain.handle = (channel, listener) => {
  ipcMain.handle(channel, listener)
  ipcMain.handle(`workspaceWindow:${channel}`, (event, ...args) => {
    authorizeWorkspaceWindowEvent(event)
    if (
      ['shell:openFilePath', 'shell:openFileUri', 'shell:pathExists', 'shell:copyFile'].includes(
        channel
      ) &&
      !args[1]
    ) {
      args[1] = { kind: 'workspace', runtimeId: null }
    }
    if (
      ['shell:openPath', 'shell:openInFileManager', 'shell:openInExternalEditor'].includes(
        channel
      ) &&
      args.length < 2
    ) {
      args.push(null)
    }
    return listener(event, ...args)
  })
}
