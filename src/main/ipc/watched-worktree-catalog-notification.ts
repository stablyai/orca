import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { notifyWorktreesChanged } from './worktree-remote'

type WorktreeCatalogRemoteClientNotifier = Pick<
  OrcaRuntimeService,
  'notifyWorktreeCatalogChangedForRemoteClients'
>

let remoteClientNotifier: WorktreeCatalogRemoteClientNotifier | null = null

export function setWorktreeCatalogRemoteClientNotifier(
  notifier: WorktreeCatalogRemoteClientNotifier | null
): void {
  remoteClientNotifier = notifier
}

export function notifyWatchedWorktreeCatalogChanged(
  mainWindow: BrowserWindow,
  repoId: string,
  connectionId?: string
): void {
  notifyWorktreesChanged(mainWindow, repoId)
  if (connectionId) {
    return
  }
  try {
    remoteClientNotifier?.notifyWorktreeCatalogChangedForRemoteClients(repoId)
  } catch (error) {
    // Why: remote fanout must not block the host renderer's watcher refresh.
    console.error('[worktrees] failed to notify remote clients of watched catalog change', error)
  }
}
