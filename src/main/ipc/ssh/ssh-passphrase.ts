import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { SSH_CREDENTIAL_TIMEOUT_MS } from '../../ssh/connection/ssh-connection-timing'
import type { SshCredentialKind } from '../../ssh/connection/ssh-connection-callbacks'
import { recordSshCredentialDeclined } from '../../ssh/ssh-credential-decline'
const pendingRequests = new Map<
  string,
  { targetId: string; resolve: (value: string | null) => void; close: () => void }
>()

function notifyCredentialResolved(
  getMainWindow: () => BrowserWindow | null,
  requestId: string
): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:credential-resolved', { requestId })
  }
}

export function requestCredential(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  kind: SshCredentialKind,
  detail: string,
  echo?: boolean,
  signal?: AbortSignal
): Promise<string | null> {
  const requestId = randomUUID()
  const { promise, resolve } = Promise.withResolvers<string | null>()
  let timer: ReturnType<typeof setTimeout>
  const finish = (value: string | null): void => {
    if (!pendingRequests.delete(requestId)) {
      return
    }
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    notifyCredentialResolved(getMainWindow, requestId)
    resolve(value)
  }
  const onAbort = (): void => finish(null)
  // Teardown abort is not a credential decline; only user cancellation or timeout declines.
  const decline = (): void => {
    if (!pendingRequests.has(requestId)) {
      return
    }
    recordSshCredentialDeclined(targetId, signal)
    finish(null)
    // One Cancel declines the host, including queued prompts that would otherwise open next.
    for (const [otherId, other] of pendingRequests) {
      if (otherId !== requestId && other.targetId === targetId) {
        other.close()
      }
    }
  }
  timer = setTimeout(decline, SSH_CREDENTIAL_TIMEOUT_MS)
  pendingRequests.set(requestId, {
    targetId,
    resolve: (value) => (value === null ? decline() : finish(value)),
    close: () => finish(null)
  })
  if (signal?.aborted) {
    finish(null)
    return promise
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:credential-request', { requestId, targetId, kind, detail, echo })
  } else {
    finish(null)
  }
  return promise
}

export function registerCredentialHandler(): void {
  ipcMain.removeHandler('ssh:submitCredential')
  ipcMain.handle(
    'ssh:submitCredential',
    (_event, args: { requestId: string; value: string | null }) => {
      pendingRequests.get(args.requestId)?.resolve(args.value)
    }
  )
}
