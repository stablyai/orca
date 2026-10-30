import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { BrowserError } from '../../browser/browser-error'

/** Asks the renderer, which owns Orca's tab model, to close one browser page. */
export async function closeBrowserTabInRenderer(
  win: Electron.BrowserWindow,
  tabId: string | null,
  worktreeId: string | undefined
): Promise<void> {
  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('browser:tabCloseReply', handler)
      reject(new Error('Tab close timed out'))
    }, 10_000)

    const handler = (
      _event: Electron.IpcMainEvent,
      reply: { requestId: string; error?: string; code?: 'browser_tab_not_found' }
    ): void => {
      if (reply.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      ipcMain.removeListener('browser:tabCloseReply', handler)
      if (reply.error) {
        reject(
          reply.code === 'browser_tab_not_found'
            ? new BrowserError('browser_tab_not_found', reply.error)
            : new Error(reply.error)
        )
      } else {
        resolve()
      }
    }
    ipcMain.on('browser:tabCloseReply', handler)
    // Why: pass worktreeId so the renderer scopes the close correctly instead of falling back to the globally active tab in the wrong worktree.
    win.webContents.send('browser:requestTabClose', { requestId, tabId, worktreeId })
  })
}
