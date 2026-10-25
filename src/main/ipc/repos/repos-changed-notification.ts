import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { wakeFolderRepoGitUpgradeWatch } from '../folder-repo-git-upgrade-wake'
import { scheduleCurrentWorktreeBaseDirectoryWatcherSync } from '../worktree-base-directory-watcher'

type RepoRemoteClientNotifier = Pick<OrcaRuntimeService, 'notifyReposChangedForRemoteClients'>

let repoRemoteClientNotifier: RepoRemoteClientNotifier | null = null

export function setRepoRemoteClientNotifier(notifier: RepoRemoteClientNotifier): void {
  repoRemoteClientNotifier = notifier
}

export function notifyReposChanged(mainWindow: BrowserWindow | null): void {
  wakeFolderRepoGitUpgradeWatch()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('repos:changed')
  }
  // Paired clients refetch only on this event, including host-side deletes and renames (#11994).
  try {
    repoRemoteClientNotifier?.notifyReposChangedForRemoteClients()
  } catch (err) {
    // Broadcast failure must not reject an already committed mutation.
    console.error('[repos] failed to notify remote clients of repo change', err)
  }
  scheduleCurrentWorktreeBaseDirectoryWatcherSync()
}
