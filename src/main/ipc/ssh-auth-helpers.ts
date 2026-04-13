import { randomUUID } from 'crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import type { SshConnectionCallbacks } from '../ssh/ssh-connection'

// Why: all three SSH auth callbacks (host-key-verify, auth-challenge, password)
// share the same IPC round-trip pattern: send a prompt event to the renderer,
// wait for a single response on a unique channel, clean up on timeout/close.
// Extracting the pattern into a generic helper avoids triplicating the cleanup
// logic and keeps ssh.ts under the max-lines threshold.
function promptRenderer<T>(
  win: BrowserWindow,
  sendChannel: string,
  sendPayload: Record<string, unknown>,
  fallback: T
): Promise<T> {
  return new Promise<T>((resolve) => {
    const responseChannel = `${sendChannel}-response-${randomUUID()}`
    const onClosed = () => {
      cleanup()
      resolve(fallback)
    }
    const cleanup = () => {
      ipcMain.removeAllListeners(responseChannel)
      clearTimeout(timer)
      win.removeListener('closed', onClosed)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(fallback)
    }, 120_000)
    win.webContents.send(sendChannel, { ...sendPayload, responseChannel })
    ipcMain.once(responseChannel, (_event, value: T) => {
      cleanup()
      resolve(value)
    })
    win.once('closed', onClosed)
  })
}

export function buildSshAuthCallbacks(
  getMainWindow: () => BrowserWindow | null
): Pick<SshConnectionCallbacks, 'onHostKeyVerify' | 'onAuthChallenge' | 'onPasswordPrompt'> {
  return {
    onHostKeyVerify: async (req) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) {
        return false
      }
      return promptRenderer<boolean>(win, 'ssh:host-key-verify', req, false)
    },

    onAuthChallenge: async (req) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) {
        return []
      }
      return promptRenderer<string[]>(win, 'ssh:auth-challenge', req, [])
    },

    onPasswordPrompt: async (targetId: string) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) {
        return null
      }
      return promptRenderer<string | null>(win, 'ssh:password-prompt', { targetId }, null)
    }
  }
}
