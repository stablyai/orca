import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { SshCredentialKind } from '../ssh/ssh-connection-utils'
import { orcaWindowManager } from '../window/orca-window-manager'
import { isCurrentRendererMainFrame } from './renderer-ipc-frame-trust'

const CREDENTIAL_TIMEOUT_MS = 120_000
type PendingCredentialRequest = {
  owner: WebContents
  resolve: (value: string | null) => void
  timer: ReturnType<typeof setTimeout>
  onOwnerDestroyed: () => void
}
const pendingRequests = new Map<string, PendingCredentialRequest>()

function notifyCredentialResolved(owner: WebContents, requestId: string): void {
  if (!owner.isDestroyed()) {
    try {
      owner.send('ssh:credential-resolved', { requestId })
    } catch {
      // The request still settles when its renderer frame disappears mid-notification.
    }
  }
}

function settleCredentialRequest(requestId: string, value: string | null): void {
  const pending = pendingRequests.get(requestId)
  if (!pending) {
    return
  }
  pendingRequests.delete(requestId)
  clearTimeout(pending.timer)
  pending.owner.removeListener('destroyed', pending.onOwnerDestroyed)
  notifyCredentialResolved(pending.owner, requestId)
  pending.resolve(value)
}

export function clearPendingCredentialRequests(): void {
  for (const requestId of pendingRequests.keys()) {
    settleCredentialRequest(requestId, null)
  }
}

export function requestCredential(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  kind: SshCredentialKind,
  detail: string
): Promise<string | null> {
  const window = orcaWindowManager.getMostRecentWindow() ?? getMainWindow()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return Promise.resolve(null)
  }
  const owner = window.webContents
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settleCredentialRequest(requestId, null)
    }, CREDENTIAL_TIMEOUT_MS)
    const onOwnerDestroyed = (): void => settleCredentialRequest(requestId, null)

    pendingRequests.set(requestId, {
      owner,
      resolve,
      timer,
      onOwnerDestroyed
    })
    owner.once('destroyed', onOwnerDestroyed)
    if (owner.isDestroyed()) {
      onOwnerDestroyed()
      return
    }
    try {
      owner.send('ssh:credential-request', { requestId, targetId, kind, detail })
    } catch {
      settleCredentialRequest(requestId, null)
    }
  })
}

export function registerCredentialHandler(): void {
  ipcMain.removeHandler('ssh:submitCredential')
  ipcMain.handle(
    'ssh:submitCredential',
    (event, args: { requestId: string; value: string | null }) => {
      const pending = pendingRequests.get(args.requestId)
      if (
        !pending ||
        event.sender !== pending.owner ||
        event.sender.isDestroyed() ||
        !isCurrentRendererMainFrame(event)
      ) {
        return
      }
      settleCredentialRequest(args.requestId, args.value)
    }
  )
}
