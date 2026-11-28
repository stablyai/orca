import { stat } from 'node:fs/promises'
import type { Repo } from '../../../../shared/repository/repo-types'
import type {
  DetectedWorktree,
  DetectedWorktreeListResult
} from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Store } from '../../../persistence/loading-store/store'
import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'
import {
  deferUntilWslDistroRunning,
  onWslDistroGateNote
} from '../../../wsl/discovery/wsl-background-distro-gate'
import {
  WslDistroStoppedError,
  WslDistroUnverifiableError
} from '../../../wsl/filesystem/wsl-unc-access-gate'
import {
  holdWslStoppedWorktreeRescan,
  releaseWslStoppedWorktreeRescan
} from '../../../wsl/discovery/wsl-stopped-worktree-rescan-registry'
import { mergeWorktree } from '../metadata/worktree-metadata-merge'
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

const REPO_FOLDER_FIRST_POLL_MS = 3_000
const REPO_FOLDER_MAX_POLL_MS = 30_000
const REPO_FOLDER_GIVE_UP_MS = 30 * 60_000

/** Re-list once a vanished repo folder (an unmounted volume) is back; shares the per-repo pending slot, so a good scan or repo removal stops it, and a later failed scan re-arms it. */
export function rescanWorktreesWhenRepoFolderReturns(repoId: string, repoPath: string): void {
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const cancel = (): void => {
    cancelled = true
    clearTimeout(timer)
  }
  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      void stat(repoPath).then(
        () => {
          if (!cancelled) {
            releaseWslStoppedWorktreeRescan(repoId, cancel)
            notifyRepoWorktreesChanged?.(repoId)
          }
        },
        () => {
          if (cancelled) {
            return
          }
          if (Date.now() - startedAt >= REPO_FOLDER_GIVE_UP_MS) {
            releaseWslStoppedWorktreeRescan(repoId, cancel)
            return
          }
          schedule(Math.min(delayMs * 2, REPO_FOLDER_MAX_POLL_MS))
        }
      )
    }, delayMs)
    timer.unref()
  }
  holdWslStoppedWorktreeRescan(repoId, cancel)
  schedule(REPO_FOLDER_FIRST_POLL_MS)
}
