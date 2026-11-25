import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import { DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE } from '../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import { BrowserError } from '../browser-error'

const SCOPE_REPLY_TIMEOUT_MS = 5_000

// The renderer owns host/workspace mappings and unmounted page records; null denies access, and
// no answer rejects so the host hears "try again" instead of a scope refusal.
export function rendererResolveRemoteCliWorkspace(
  getWindow: () => BrowserWindow | null,
  query: { environmentId: string; workspaceId?: string; pageId?: string }
): Promise<string | null> {
  const win = getWindow()
  if (!win || win.isDestroyed()) {
    return Promise.reject(
      new BrowserError(
        DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
        'The Orca desktop has no open window to check which workspaces this host may use. Open Orca on the desktop and try again.'
      )
    )
  }
  const rendererWebContents = win.webContents
  const requestId = randomUUID()
  return new Promise<string | null>((resolve, reject) => {
    const finish = (outcome: { workspaceId: string | null } | { error: BrowserError }): void => {
      clearTimeout(timer)
      ipcMain.removeListener('browser:remoteCliScopeReply', handler)
      if ('error' in outcome) {
        reject(outcome.error)
      } else {
        resolve(outcome.workspaceId)
      }
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
      finish({
        workspaceId:
          'workspaceId' in reply && typeof reply.workspaceId === 'string' && reply.workspaceId
            ? reply.workspaceId
            : null
      })
    }
    const timer = setTimeout(
      () =>
        finish({
          error: new BrowserError(
            'browser_timeout',
            `The Orca desktop window did not answer within ${SCOPE_REPLY_TIMEOUT_MS / 1000} seconds, so nothing ran. Try again.`
          )
        }),
      SCOPE_REPLY_TIMEOUT_MS
    )
    ipcMain.on('browser:remoteCliScopeReply', handler)
    rendererWebContents.send('browser:requestRemoteCliScope', { requestId, ...query })
  })
}
