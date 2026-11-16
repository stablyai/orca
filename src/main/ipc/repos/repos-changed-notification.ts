import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { wakeFolderRepoGitUpgradeWatch } from '../folder-repo-git-upgrade-wake'
import { scheduleCurrentWorktreeBaseDirectoryWatcherSync } from '../worktrees/creation/worktree-base-directory-watcher'

type RepoRemoteClientNotifier = Pick<
  OrcaRuntimeService,
  'notifyReposChangedForRemoteClients' | 'notifyAutomationsChanged'
>

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
  broadcast('repo', () => repoRemoteClientNotifier?.notifyReposChangedForRemoteClients())
  // Automation owners are projected from projects, so open lists must re-read them (STA-12812).
  broadcast('automation', () =>
    repoRemoteClientNotifier?.notifyAutomationsChanged({ reason: 'definition' })
  )
  scheduleCurrentWorktreeBaseDirectoryWatcherSync()
}

// Broadcast failure must not reject an already committed mutation or skip the other broadcast.
function broadcast(kind: string, send: () => void): void {
  try {
    send()
  } catch (err) {
    console.error(`[repos] failed to notify ${kind} change for a repo change`, err)
  }
}
