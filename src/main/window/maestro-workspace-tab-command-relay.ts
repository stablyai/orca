import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import type {
  RuntimeMaestroWorkspaceTabCommand,
  RuntimeMaestroWorkspaceTabCommandResponse
} from '../../shared/runtime-types'

const RESPONSE_CHANNEL = 'ui:maestroWorkspaceTabCommandResponse'
const COMMAND_CHANNEL = 'ui:maestroWorkspaceTabCommand'
const COMMAND_TIMEOUT_MS = 10_000
type MaestroWorkspaceTabCommandInput = RuntimeMaestroWorkspaceTabCommand extends infer Command
  ? Command extends RuntimeMaestroWorkspaceTabCommand
    ? Omit<Command, 'requestId'>
    : never
  : never

export async function requestMaestroWorkspaceTabCommand(
  mainWindow: BrowserWindow,
  command: MaestroWorkspaceTabCommandInput
): Promise<{ tabId: string; content?: string; modelRevision?: string }> {
  const requestId = randomUUID()
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener(RESPONSE_CHANNEL, onResponse)
      reject(new Error('Maestro workspace tab command timed out.'))
    }, COMMAND_TIMEOUT_MS)
    const onResponse = (
      event: Electron.IpcMainEvent,
      response: RuntimeMaestroWorkspaceTabCommandResponse
    ): void => {
      if (event.sender !== mainWindow.webContents || response.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      ipcMain.removeListener(RESPONSE_CHANNEL, onResponse)
      if (!response.ok || !response.tabId) {
        reject(new Error(response.error ?? 'Maestro workspace tab command failed.'))
        return
      }
      resolve({
        tabId: response.tabId,
        ...(response.content !== undefined ? { content: response.content } : {}),
        ...(response.modelRevision !== undefined ? { modelRevision: response.modelRevision } : {})
      })
    }
    ipcMain.on(RESPONSE_CHANNEL, onResponse)
    mainWindow.webContents.send(COMMAND_CHANNEL, { ...command, requestId })
  })
}
