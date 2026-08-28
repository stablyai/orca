import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { wakeFolderRepoGitUpgradeWatch } from '../folder-repo-git-upgrade-wake'
import { scheduleCurrentWorktreeBaseDirectoryWatcherSync } from '../worktree-base-directory-watcher'

type RepoRemoteClientNotifier = Pick<OrcaRuntimeService, 'notifyReposChangedForRemoteClients'>

// Why: notifyReposChanged is module-level and cannot close over a handler argument (#11994).
let repoRemoteClientNotifier: RepoRemoteClientNotifier | null = null

export function setRepoRemoteClientNotifier(notifier: RepoRemoteClientNotifier): void {
  repoRemoteClientNotifier = notifier
}

export function notifyReposChanged(mainWindow: BrowserWindow): void {
  wakeFolderRepoGitUpgradeWatch()
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('repos:changed')
  }
  // Why: paired clients only refetch a remote catalog on this event; without it a
  // host-side delete or rename stays invisible to them indefinitely (#11994).
  try {
    repoRemoteClientNotifier?.notifyReposChangedForRemoteClients()
  } catch (err) {
    // Why: a broadcast failure must never fail the mutation the user actually asked for.
    console.error('[repos] failed to notify remote clients of repo change', err)
  }
  scheduleCurrentWorktreeBaseDirectoryWatcherSync()
}
