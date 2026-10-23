import { app } from 'electron'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { getTrustedUIRendererWindow } from './ui'

export function createNotificationSubjectReveal(
  args: NotificationDispatchRequest
): (() => void) | null {
  const worktreeId = args.worktreeId
  const paneTarget = args.paneKey ? parsePaneKey(args.paneKey) : null
  // Why: a structured chat has no PTY pane. Its pane key's leaf is a synthetic id minted from
  // the session, so focusTerminal would hunt a split-layout leaf that does not exist; the
  // unified tab id in the same key is what reveals the chat.
  const chatTarget = args.surface === 'agent-session' ? paneTarget : null
  // Why: only a "repoId::worktreePath" id has a repo to activate. Folder and floating workspaces have
  // none; a pane reveal shows its workspace where it lives on its own, so it still binds the click.
  const repoId = worktreeId?.includes('::') ? getRepoIdFromWorktreeId(worktreeId) : null
  if (!worktreeId || (repoId === null && !paneTarget)) {
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
      ackPaneKeyOnSuccess: args.paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  }
}
