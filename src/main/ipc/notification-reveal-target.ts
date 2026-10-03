import { app } from 'electron'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { getTrustedUIRendererWindow } from './ui'

export type NotificationRevealTarget = Pick<
  NotificationDispatchRequest,
  'worktreeId' | 'paneKey' | 'surface'
>

/** The click action that reveals a notification's worktree and pane, or null when nothing can be revealed. */
export function createNotificationRevealHandler(
  target: NotificationRevealTarget
): (() => void) | null {
  const { worktreeId, paneKey } = target
  const paneTarget = paneKey ? parsePaneKey(paneKey) : null
  // Why: a structured chat has no PTY pane. Its pane key's leaf is a synthetic id minted from
  // the session, so focusTerminal would hunt a split-layout leaf that does not exist; the
  // unified tab id in the same key is what reveals the chat.
  const chatTarget = target.surface === 'agent-session' ? paneTarget : null
  // Why: worktreeId is formatted "repoId::worktreePath"; without the separator we can't extract a
  // repoId to activate. A folder workspace ("folder:<id>") has none, but a chat reveal selects its
  // workspace itself, so only the terminal route needs the repoId to bind a click at all.
  const repoId = worktreeId?.includes('::') ? getRepoIdFromWorktreeId(worktreeId) : null
  if (!worktreeId || (repoId === null && !chatTarget)) {
    return null
  }
  return () => {
    const win = getTrustedUIRendererWindow()
    if (!win || win.isDestroyed()) {
      return
    }
    if (process.platform === 'darwin' && !isBackgroundLaunch()) {
      app.focus({ steal: true })
    }
    safelyRevealWindow(win)
    if (repoId !== null) {
      win.webContents.send('ui:activateWorktree', { repoId, worktreeId })
    }
    if (chatTarget) {
      win.webContents.send('ui:focusEditorTab', {
        tabId: chatTarget.tabId,
        worktreeId,
        userInitiated: true
      })
      return
    }
    if (!paneTarget) {
      return
    }
    // Why: focusTerminal targets the pane by stable leafId so split-pane notifications land on the exact pane.
    win.webContents.send('ui:focusTerminal', {
      tabId: paneTarget.tabId,
      worktreeId,
      leafId: paneTarget.leafId,
      ackPaneKeyOnSuccess: paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  }
}
