import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'

const TERMINAL_GRID_ROLLBACK_TIMEOUT_MS = 10_000

export function requestTerminalGridAppendRollback(
  mainWindow: BrowserWindow,
  identity: { transactionId: string; tabId: string; leafId: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const handler = (
      event: Electron.IpcMainEvent,
      reply: { requestId: string; error?: string }
    ): void => {
      if (event.sender !== mainWindow.webContents || reply.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      ipcMain.removeListener('terminal:gridAppendRollbackReply', handler)
      if (reply.error) {
        reject(new Error(reply.error))
        return
      }
      resolve()
    }
    const timer = setTimeout(() => {
      ipcMain.removeListener('terminal:gridAppendRollbackReply', handler)
      reject(new Error('Terminal grid append rollback acknowledgement timed out'))
    }, TERMINAL_GRID_ROLLBACK_TIMEOUT_MS)
    ipcMain.on('terminal:gridAppendRollbackReply', handler)
    try {
      mainWindow.webContents.send('ui:rollbackTerminalGridAppend', {
        requestId,
        ...identity
      })
    } catch (error) {
      clearTimeout(timer)
      ipcMain.removeListener('terminal:gridAppendRollbackReply', handler)
      reject(error)
    }
  })
}
