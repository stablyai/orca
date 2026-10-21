import { randomUUID } from 'node:crypto'

import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  TerminalPaneRevealReply,
  TerminalPaneRevealTarget
} from '../../shared/terminal-pane-reveal'
import { focusExistingMainWindow } from './focus-existing-window'

const TERMINAL_PANE_REVEAL_TIMEOUT_MS = 10_000

/** Shows a pane in the window, then raises the window; resolves false when it does not know the worktree. */
export async function revealTerminalPaneInWindow(
  mainWindow: BrowserWindow,
  target: TerminalPaneRevealTarget
): Promise<boolean> {
  const revealed = await requestTerminalPaneRevealFromRenderer(mainWindow, target)
  if (revealed) {
    focusExistingMainWindow({
      app,
      getWindow: () => mainWindow,
      // Why: a reveal moves the window that answered; it never opens a replacement.
      canOpenWindow: () => false,
      openWindow: () => mainWindow
    })
  }
  return revealed
}

function requestTerminalPaneRevealFromRenderer(
  mainWindow: BrowserWindow,
  target: TerminalPaneRevealTarget
): Promise<boolean> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new Error('renderer_unavailable'))
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return new Promise<boolean>((resolve, reject) => {
    const finish = (error: Error | null, revealed = false): void => {
      clearTimeout(timeout)
      ipcMain.removeListener('ui:terminalPaneRevealReply', onReply)
      if (error) {
        reject(error)
      } else {
        resolve(revealed)
      }
    }
    const timeout = setTimeout(
      () => finish(new Error('terminal_reveal_timeout')),
      TERMINAL_PANE_REVEAL_TIMEOUT_MS
    )
    const onReply = (event: Electron.IpcMainEvent, reply: TerminalPaneRevealReply): void => {
      // Why: request ids are visible to renderer code; only the targeted window may answer.
      if (event.sender !== webContents || reply.requestId !== requestId) {
        return
      }
      finish(null, reply.revealed === true)
    }
    ipcMain.on('ui:terminalPaneRevealReply', onReply)
    webContents.send('ui:revealTerminalPane', { ...target, requestId })
  })
}
