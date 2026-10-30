import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'

export async function createBrowserTabInRenderer(
  host: Pick<RuntimeBrowserCommandHost, 'getAuthoritativeWindow'>,
  url: string,
  worktreeId: string | undefined,
  profileId: string | undefined,
  sessionPartition: string | undefined,
  activate?: boolean,
  requestedPageId?: string,
  /** Used only when `worktreeId` is unset and no workspace is active in the renderer. */
  fallbackWorktreeId?: string
): Promise<{ browserPageId: string }> {
  const rendererWebContents = host.getAuthoritativeWindow().webContents
  const requestId = randomUUID()

  const browserPageId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('browser:tabCreateReply', handler)
      reject(new Error('Tab creation timed out'))
    }, 10_000)

    const handler = (
      event: Electron.IpcMainEvent,
      reply: { requestId: string; browserPageId?: string; error?: string }
    ): void => {
      if (event.sender !== rendererWebContents || reply.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      ipcMain.removeListener('browser:tabCreateReply', handler)
      if (reply.error) {
        reject(new Error(reply.error))
      } else {
        resolve(reply.browserPageId!)
      }
    }
    ipcMain.on('browser:tabCreateReply', handler)
    rendererWebContents.send('browser:requestTabCreate', {
      requestId,
      url,
      worktreeId,
      ...(requestedPageId ? { browserPageId: requestedPageId } : {}),
      // undefined preserves renderer default-profile inheritance; null would override it.
      sessionProfileId: profileId,
      sessionPartition,
      activate,
      ...(fallbackWorktreeId ? { fallbackWorktreeId } : {})
    })
  })

  return { browserPageId }
}
