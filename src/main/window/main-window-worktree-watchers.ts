import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import {
  scheduleWorktreeBaseDirectoryWatcherSync,
  setWorktreeBaseDirectoryWatcherSyncContext
} from '../ipc/worktree-base-directory-watcher'
import { startFolderRepoGitUpgradeWatch } from '../ipc/folder-repo-git-upgrade'
import { desktopWindowId } from './desktop-renderer-registry'
import { preferredNativeDesktopWindow } from './native-desktop-windows'

export function attachMainWindowWorktreeWatchers(store: Store, window: BrowserWindow): void {
  const bind = (target: BrowserWindow): void => {
    setWorktreeBaseDirectoryWatcherSyncContext(store, target)
    scheduleWorktreeBaseDirectoryWatcherSync(store, target)
    startFolderRepoGitUpgradeWatch(store, target)
  }
  bind(window)
  if (!desktopWindowId(window.webContents)) {
    return
  }
  window.on('focus', () => bind(window))
  window.once('closed', () => {
    const surviving = preferredNativeDesktopWindow()
    if (surviving) {
      bind(surviving)
    }
  })
}
