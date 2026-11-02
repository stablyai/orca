import { randomUUID } from 'node:crypto'

import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  TerminalPaneRevealReply,
  TerminalPaneRevealTarget
} from '../../shared/terminal-pane-reveal'
import { addFanoutListener } from '../event-listener-fanout'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
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
      // Reveal only the answering window; never construct a replacement.
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
    let settled = false
    const releaseListeners: (() => void)[] = []
    const finish = (error: Error | null, revealed = false): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      for (const release of releaseListeners) {
        release()
      }
      if (error) {
        reject(error)
      } else {
        resolve(revealed)
      }
    }
    const onRendererUnavailable = (): void => finish(new Error('renderer_unavailable'))
    const timeout = setTimeout(
      () => finish(new Error('terminal_reveal_timeout')),
      TERMINAL_PANE_REVEAL_TIMEOUT_MS
    )
    const onReply = (event: Electron.IpcMainEvent, reply: TerminalPaneRevealReply): void => {
      // Visible request IDs confer no authority; only the targeted window can answer.
      if (event.sender !== webContents || reply.requestId !== requestId) {
        return
      }
      finish(null, reply.revealed === true)
    }
    const lifetime = abortWhenRendererGone(webContents)
    lifetime.signal.addEventListener('abort', onRendererUnavailable, { once: true })
    releaseListeners.push(
      lifetime.dispose,
      () => lifetime.signal.removeEventListener('abort', onRendererUnavailable),
      addFanoutListener(mainWindow, 'closed', onRendererUnavailable),
      addFanoutListener(ipcMain, 'ui:terminalPaneRevealReply', onReply)
    )
    try {
      webContents.send('ui:revealTerminalPane', { ...target, requestId })
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
