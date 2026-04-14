import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { SshCredentialKind } from '../ssh/ssh-connection-utils'

const CREDENTIAL_TIMEOUT_MS = 120_000
const pendingRequests = new Map<string, { resolve: (value: string | null) => void }>()

export function requestCredential(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  kind: SshCredentialKind,
  detail: string
): Promise<string | null> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingRequests.delete(requestId)) {
        resolve(null)
      }
    }, CREDENTIAL_TIMEOUT_MS)

    pendingRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      }
    })

    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('ssh:credential-request', { requestId, targetId, kind, detail })
    } else {
      pendingRequests.delete(requestId)
      clearTimeout(timer)
      resolve(null)
    }
  })
}

export function registerCredentialHandler(): void {
  ipcMain.removeHandler('ssh:submitCredential')
  ipcMain.handle(
    'ssh:submitCredential',
    (_event, args: { requestId: string; value: string | null }) => {
      const pending = pendingRequests.get(args.requestId)
      if (pending) {
        pendingRequests.delete(args.requestId)
        pending.resolve(args.value)
      }
    }
  )
}
