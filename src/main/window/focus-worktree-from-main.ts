import { app } from 'electron'
import { getTrustedUIRendererWindow } from '../ipc/ui'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { safelyRevealWindow } from './activation/focus-existing-window'
import { isBackgroundLaunch } from './activation/foreground-activation-policy'

export function focusWorktreeFromMain(worktreeId: string): void {
  if (!worktreeId.includes('::')) {
    return
  }
  // Why the trusted lookup rather than getAllWindows()[0]: a devtools or child
  // window can be first, and this sends an IPC the renderer acts on. The reveal
  // sequence is the shared one the native-notification click handler uses
  // (src/main/ipc/native-notification-delivery.ts).
  const win = getTrustedUIRendererWindow()
  if (!win || win.isDestroyed()) {
    return
  }
  if (process.platform === 'darwin' && !isBackgroundLaunch()) {
    app.focus({ steal: true })
  }
  safelyRevealWindow(win)
  win.webContents.send('ui:activateWorktree', {
    repoId: getRepoIdFromWorktreeId(worktreeId),
    worktreeId
  })
}
