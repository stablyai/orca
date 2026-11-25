import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { notifyWorktreesChanged } from '../worktree-remote'
import { runWorktreeChangeInvalidators } from './worktree-change-invalidators'

type WorktreeCatalogRemoteClientNotifier = Pick<
  OrcaRuntimeService,
  'notifyWorktreeCatalogChangedForRemoteClients' | 'notifyGitStatusChangedForRemoteClients'
>

let remoteClientNotifier: WorktreeCatalogRemoteClientNotifier | null = null

export function setWorktreeCatalogRemoteClientNotifier(
  notifier: WorktreeCatalogRemoteClientNotifier | null
): void {
  remoteClientNotifier = notifier
}

export function notifyWatchedWorktreeCatalogChanged(
  mainWindow: BrowserWindow,
  repoId: string
): void {
  notifyWorktreesChanged(mainWindow, repoId)
  notifyRemoteClientsOfWatchedCatalogChange(repoId)
}

/** Listed heads moved without structure: stale owners must rescan, but the local renderer patches its rows. */
export function notifyWatchedWorktreeHeadsMoved(repoId: string): void {
  runWorktreeChangeInvalidators(repoId)
  notifyRemoteClientsOfWatchedCatalogChange(repoId)
}

function notifyRemoteClientsOfWatchedCatalogChange(repoId: string): void {
  try {
    remoteClientNotifier?.notifyWorktreeCatalogChangedForRemoteClients(repoId)
  } catch (error) {
    // Remote fanout failure must not block host renderer refresh.
    console.error('[worktrees] failed to notify remote clients of watched catalog change', error)
  }
}

export function notifyGitStatusChangedForRemoteClients(
  repoId: string,
  worktreePaths: readonly string[] | null
): void {
  try {
    remoteClientNotifier?.notifyGitStatusChangedForRemoteClients(repoId, worktreePaths)
  } catch (error) {
    console.error('[worktrees] failed to notify remote clients of git status change', error)
  }
}
