import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import type { BrowserTabSplitDirection } from '../../../shared/browser-tab-split-direction'
import type { BrowserTabCreateRequest } from '../../../shared/browser-tab-create-request'

export async function createBrowserTabInRenderer(
  host: Pick<RuntimeBrowserCommandHost, 'getAuthoritativeWindow'>,
  url: string,
  worktreeId: string | undefined,
  profileId: string | undefined,
  sessionPartition: string | undefined,
  activate?: boolean,
  requestedPageId?: string,
  split?: { direction: BrowserTabSplitDirection; fromTabId?: string }
): Promise<{ browserPageId: string }> {
  const win = host.getAuthoritativeWindow()
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
      if (event.sender !== win.webContents || reply.requestId !== requestId) {
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
    const request: BrowserTabCreateRequest = {
      requestId,
      url,
      worktreeId,
      ...(requestedPageId ? { browserPageId: requestedPageId } : {}),
      // Why: keep these undefined (not null) when no profile is chosen so the renderer still applies default-profile inheritance.
      sessionProfileId: profileId,
      sessionPartition,
      activate,
      ...(split ? { split: split.direction, splitFromTabId: split.fromTabId } : {})
    }
    win.webContents.send('browser:requestTabCreate', request)
  })

  return { browserPageId }
}
