import type { Repo } from '../../../../shared/repo-types'
import type {
  DetectedWorktree,
  DetectedWorktreeListResult
} from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Store } from '../../../persistence/loading-store/store'
import { areWorktreePathsEqual } from '../../../git/worktree-path-comparison'
import {
  deferUntilWslDistroRunning,
  onWslDistroGateNote
} from '../../../wsl-background-distro-gate'
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../../../wsl/wsl-unc-access-gate'
import {
  holdWslStoppedWorktreeRescan,
  releaseWslStoppedWorktreeRescan
} from '../../../wsl-stopped-worktree-rescan-registry'
import { mergeWorktree } from '../../worktree-metadata-merge'
import { buildDisconnectedDetectedWorktrees } from './folder-workspace-catalog'
import {
  createSshWorktreeMetaIndexForRepo,
  listDisconnectedSshWorktrees
} from './ssh-worktree-fallback'

export type WslDistroNotRunning = NonNullable<DetectedWorktreeListResult['wslDistroStopped']>

let notifyRepoWorktreesChanged: ((repoId: string) => void) | null = null

export function setWslStoppedWorktreeRescanNotifier(
  notify: ((repoId: string) => void) | null
): void {
  notifyRepoWorktreesChanged = notify
}

export function wslDistroNotRunningForScanFailure(error: unknown): WslDistroNotRunning | null {
  if (error instanceof WslDistroStoppedError) {
    return { distro: error.distro, state: 'stopped' }
  }
  if (error instanceof WslDistroUnverifiableError) {
    return { distro: error.distro, state: 'unverifiable' }
  }
  return null
}

/** Stored rows for a repo whose distro the gate refused to start; the main checkout always exists. */
export function listWslStoppedWorktrees(
  store: Store,
  repo: Repo,
  allMeta: Record<string, WorktreeMeta> | undefined
): DetectedWorktree[] {
  const known = listDisconnectedSshWorktrees(
    store,
    repo,
    createSshWorktreeMetaIndexForRepo(allMeta ?? {}, repo.id)
  )
  const worktrees = known.some((worktree) => areWorktreePathsEqual(worktree.path, repo.path))
    ? known
    : [
        mergeWorktree(
          repo.id,
          { path: repo.path, head: '', branch: '', isBare: false, isMainWorktree: true },
          undefined,
          repo.displayName
        ),
        ...known
      ]
  return buildDisconnectedDetectedWorktrees(store, repo, worktrees)
}

/** Re-list on a wake or a settled running read; never probes, and holds one pending re-scan per repo. */
export function rescanWorktreesWhenWslDistroRuns(repoId: string, distro: string): void {
  const wanted = distro.trim().toLowerCase()
  const rescan = (): void => {
    releaseWslStoppedWorktreeRescan(repoId, cancel)
    notifyRepoWorktreesChanged?.(repoId)
  }
  const cancelDeferred = deferUntilWslDistroRunning(distro, `worktree-scan:${repoId}`, rescan)
  const unsubscribeNotes = onWslDistroGateNote((note) => {
    if (note.kind === 'woken' && note.distro.trim().toLowerCase() === wanted) {
      rescan()
    }
  })
  const cancel = (): void => {
    cancelDeferred()
    unsubscribeNotes()
  }
  holdWslStoppedWorktreeRescan(repoId, cancel)
}
