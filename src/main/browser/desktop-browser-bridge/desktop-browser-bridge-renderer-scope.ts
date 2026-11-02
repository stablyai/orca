import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'

const SCOPE_REPLY_TIMEOUT_MS = 5_000

// The renderer owns host/workspace mappings and unmounted page records; null denies access.
export function rendererResolveRemoteCliWorkspace(
  getWindow: () => BrowserWindow | null,
  query: { environmentId: string; workspaceId?: string; pageId?: string }
): Promise<string | null> {
  const win = getWindow()
  if (!win || win.isDestroyed()) {
    return Promise.resolve(null)
  }
  const rendererWebContents = win.webContents
  const requestId = randomUUID()
  return new Promise<string | null>((resolve) => {
    const finish = (workspaceId: string | null): void => {
      clearTimeout(timer)
      ipcMain.removeListener('browser:remoteCliScopeReply', handler)
      resolve(workspaceId)
    }
    const handler = (event: Electron.IpcMainEvent, reply: unknown): void => {
      if (
        event.sender !== rendererWebContents ||
        !reply ||
        typeof reply !== 'object' ||
        !('requestId' in reply) ||
        reply.requestId !== requestId
      ) {
        return
      }
      finish(
        'workspaceId' in reply && typeof reply.workspaceId === 'string' && reply.workspaceId
          ? reply.workspaceId
          : null
      )
    }
    const timer = setTimeout(() => finish(null), SCOPE_REPLY_TIMEOUT_MS)
    ipcMain.on('browser:remoteCliScopeReply', handler)
    rendererWebContents.send('browser:requestRemoteCliScope', { requestId, ...query })
  })
}
