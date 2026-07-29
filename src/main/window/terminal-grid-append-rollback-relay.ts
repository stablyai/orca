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

export async function rollbackMismatchedTerminalGridAppend(
  mainWindow: BrowserWindow,
  identity: { transactionId: string; tabId: string; leafId: string }
): Promise<never> {
  const mismatchError = new Error('Terminal grid reply did not match its staged identity')
  try {
    // Why: the renderer has already committed this actual identity; remove it
    // before main rejects and aborts the staged PTY.
    await requestTerminalGridAppendRollback(mainWindow, identity)
  } catch (rollbackError) {
    throw new AggregateError(
      [mismatchError, rollbackError],
      `${mismatchError.message}; renderer rollback failed`
    )
  }
  throw mismatchError
}
