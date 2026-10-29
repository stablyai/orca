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
  repoId: string
): void {
  notifyWorktreesChanged(mainWindow, repoId)
  try {
    remoteClientNotifier?.notifyWorktreeCatalogChangedForRemoteClients(repoId)
  } catch (error) {
    // Remote fanout failure must not block host renderer refresh.
    console.error('[worktrees] failed to notify remote clients of watched catalog change', error)
  }
}
