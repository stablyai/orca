import { ipcMain } from 'electron'
import { WORKSPACE_WINDOW_FILE_TRANSFER_METHODS } from '../../shared/workspace-window-file-transfer'
import { authorizeWorkspaceWindowEvent } from './workspace-window-native-bridge'

const channels = new Set<string>(
  WORKSPACE_WINDOW_FILE_TRANSFER_METHODS.map((method) => `fs:${method}`)
)

export const registerWorkspaceWindowFileTransferHandler: typeof ipcMain.handle = (
  channel,
  listener
) => {
  ipcMain.handle(channel, listener)
  if (channels.has(channel)) {
    ipcMain.handle(`workspaceWindow:${channel}`, (event, ...args) => {
      authorizeWorkspaceWindowEvent(event)
      return listener(event, ...args)
    })
  }
}
