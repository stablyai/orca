import { win32 } from 'node:path'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type {
  WorkspaceCopyListEntry,
  WorkspaceCopyListResult
} from '../../shared/perforce/workspace-copy/workspace-copy-types'
import { splitWorktreeId } from '../../shared/worktree/id'
import {
  getPerforceCopyName,
  getPerforceCopyWorktreeId,
  isPerforceCopyWorktreeIdForRepo
} from '../../shared/worktree/perforce-copy-worktree'
import type { Store } from '../persistence'

export type CopyWorktreeStore = Pick<
  Store,
  'getWorktreeMeta' | 'setWorktreeMeta' | 'getAllWorktreeMeta'
>

/**
 * The copy's counterpart of the project folder: the copy root itself, or the same subfolder inside it
 * when the project is a folder below the client root. Copies exist only on Windows hosts, so their
 * paths follow Windows rules whatever this computer runs.
 */
export function copyWorktreePath(repo: Repo, sourceRoot: string, copyRoot: string): string {
  const inside = win32.relative(sourceRoot, repo.path)
  return inside && !inside.startsWith('..') ? win32.join(copyRoot, inside) : copyRoot
}

/** Records a copy as a worktree of `repo`; creation metadata makes it a visible Orca workspace. */
function recordCopyWorktree(
  store: CopyWorktreeStore,
  repo: Repo,
  worktreePath: string,
  name: string,
  createdAt: number
): void {
  const worktreeId = getPerforceCopyWorktreeId(repo, worktreePath)
  if (!store.getWorktreeMeta(worktreeId)) {
    store.setWorktreeMeta(worktreeId, {
      displayName: name,
      createdAt,
      orcaCreatedAt: createdAt,
      orcaCreationSource: getRepoSshConnectionId(repo) ? 'ssh' : 'desktop',
      lastActivityAt: createdAt
    })
  }
}

function createdAtOf(copy: WorkspaceCopyListEntry): number {
  const parsed = copy.created ? Date.parse(copy.created) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/**
 * Makes the sidebar match the copies on disk: adopts copies made outside Orca in the same layout
 * and forgets ones whose folder is gone. A folder whose client the server no longer has stays out of
 * the sidebar; Manage Perforce copies lists it for cleanup. Returns whether anything changed.
 */
export function syncCopyWorktrees(
  store: CopyWorktreeStore,
  repo: Repo,
  listing: WorkspaceCopyListResult,
  forgetWorktree: (worktreeId: string) => void
): boolean {
  let changed = false
  const live = new Set<string>()
  for (const copy of listing.copies) {
    const usable = copy.folderExists && (copy.clientExists || !listing.serverChecked)
    if (!usable) {
      continue
    }
    const path = copyWorktreePath(repo, listing.source.root, copy.copyRoot)
    const worktreeId = getPerforceCopyWorktreeId(repo, path)
    live.add(worktreeId)
    const existing = store.getWorktreeMeta(worktreeId)
    if (!existing) {
      recordCopyWorktree(store, repo, path, copy.name, createdAtOf(copy))
      changed = true
    }
    if (copy.stream && existing?.perforceStream !== copy.stream) {
      store.setWorktreeMeta(worktreeId, { perforceStream: copy.stream })
      changed = true
    }
  }
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    if (isPerforceCopyWorktreeIdForRepo(repo, worktreeId) && !live.has(worktreeId)) {
      const copyRootGone = !listing.copies.some(
        (copy) =>
          copy.folderExists &&
          getPerforceCopyWorktreeId(
            repo,
            copyWorktreePath(repo, listing.source.root, copy.copyRoot)
          ) === worktreeId
      )
      if (copyRootGone) {
        forgetWorktree(worktreeId)
        changed = true
      }
    }
  }
  return changed
}

export function copyWorktreeIdForName(
  store: CopyWorktreeStore,
  repo: Repo,
  name: string
): { worktreeId: string; path: string } | null {
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    const path = splitWorktreeId(worktreeId)?.worktreePath
    if (
      path &&
      isPerforceCopyWorktreeIdForRepo(repo, worktreeId) &&
      getPerforceCopyName(path)?.toLowerCase() === name.toLowerCase()
    ) {
      return { worktreeId, path }
    }
  }
  return null
}
