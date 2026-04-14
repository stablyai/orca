import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'

const PASSPHRASE_TIMEOUT_MS = 120_000
const pendingRequests = new Map<string, { resolve: (passphrase: string | null) => void }>()

/**
 * Ask the renderer to show a passphrase dialog and wait for the response.
 * Returns null if the user cancels or the prompt times out.
 */
export function requestPassphrase(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  keyPath: string
): Promise<string | null> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingRequests.delete(requestId)) {
        resolve(null)
      }
    }, PASSPHRASE_TIMEOUT_MS)

    pendingRequests.set(requestId, {
      resolve: (passphrase) => {
        clearTimeout(timer)
        resolve(passphrase)
      }
    })

    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('ssh:passphrase-request', { requestId, targetId, keyPath })
    } else {
      pendingRequests.delete(requestId)
      clearTimeout(timer)
      resolve(null)
    }
  })
}

export function registerPassphraseHandler(): void {
  ipcMain.removeHandler('ssh:submitPassphrase')
  ipcMain.handle(
    'ssh:submitPassphrase',
    (_event, args: { requestId: string; passphrase: string | null }) => {
      const pending = pendingRequests.get(args.requestId)
      if (pending) {
        pendingRequests.delete(args.requestId)
        pending.resolve(args.passphrase)
      }
    }
  )
}
