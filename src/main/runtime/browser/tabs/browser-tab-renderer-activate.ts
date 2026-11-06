import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'

/** Asks the renderer, which owns Orca's tab model, to make one browser page the active tab. */
export async function activateBrowserTabInRenderer(
  win: Electron.BrowserWindow,
  browserPageId: string
): Promise<void> {
  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('browser:tabActivateReply', handler)
      reject(new Error('Tab activation timed out'))
    }, 10_000)

    const handler = (
      event: Electron.IpcMainEvent,
      reply: { requestId: string; error?: string }
    ): void => {
      if (event.sender !== win.webContents || reply?.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      ipcMain.removeListener('browser:tabActivateReply', handler)
      if (reply.error) {
        reject(new Error(reply.error))
      } else {
        resolve()
      }
    }
    ipcMain.on('browser:tabActivateReply', handler)
    win.webContents.send('browser:requestTabActivate', { requestId, browserPageId })
  })
}
