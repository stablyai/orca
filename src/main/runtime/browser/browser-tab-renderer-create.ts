import { beginConditionalWorktreeGlobalUse } from '../../ipc/conditional-worktree-removal-lease'
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
  const releaseConditionalUse = beginConditionalWorktreeGlobalUse()
  let sendStarted = false
  let replied = false
  let cleanupRequest = (): void => {}
  try {
    const rendererWebContents = host.getAuthoritativeWindow().webContents
    const requestId = randomUUID()

    const browserPageId = await new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const handler = (
        event: Electron.IpcMainEvent,
        reply: { requestId: string; browserPageId?: string; error?: string }
      ): void => {
        if (event.sender !== rendererWebContents || reply.requestId !== requestId) {
          return
        }
        replied = true
        cleanupRequest()
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve(reply.browserPageId!)
        }
      }
      cleanupRequest = () => {
        cleanupRequest = () => {}
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCreateReply', handler)
      }
      timer = setTimeout(() => {
        cleanupRequest()
        reject(new Error('Tab creation timed out'))
      }, 10_000)
      ipcMain.on('browser:tabCreateReply', handler)
      sendStarted = true
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
  } finally {
    cleanupRequest()
    // Only pre-dispatch failure or an exact reply settles creation.
    if (!sendStarted || replied) {
      releaseConditionalUse()
    }
  }
}
