import { app, type BrowserWindow } from 'electron'

import type {
  TerminalPaneRevealReply,
  TerminalPaneRevealTarget
} from '../../../shared/workspace-layout/terminal-surfaces/terminal-pane-reveal'
import { focusExistingMainWindow } from '../activation/focus-existing-window'
import { requestRendererReply } from './renderer-reply-request'

const TERMINAL_PANE_REVEAL_TIMEOUT_MS = 10_000

/** Shows a pane in the window, then raises the window; resolves false when it does not know the worktree. */
export async function revealTerminalPaneInWindow(
  mainWindow: BrowserWindow,
  target: TerminalPaneRevealTarget
): Promise<boolean> {
  const reply = await requestRendererReply<TerminalPaneRevealReply>(mainWindow, {
    requestChannel: 'ui:revealTerminalPane',
    replyChannel: 'ui:terminalPaneRevealReply',
    payload: target,
    timeoutMs: TERMINAL_PANE_REVEAL_TIMEOUT_MS,
    timeoutError: 'terminal_reveal_timeout'
  })
  const revealed = reply.revealed === true
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
