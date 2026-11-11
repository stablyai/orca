import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import type {
  WorkspaceCopyListEntry,
  WorkspaceCopyListResult
} from '../../shared/perforce/workspace-copy/workspace-copy-types'
import { splitWorktreeId } from '../../shared/worktree/id'
import {
  getPerforceCopyName,
  getPerforceCopySourcePath,
  getPerforceCopyWorktreeId,
  isPerforceCopyWorktreeIdForRepo
} from '../../shared/worktree/perforce-copy-worktree'
import type { Store } from '../persistence/loading-store/store'
import { hostWorktreeTargetForRepo } from '../persistence/host-qualified-worktree-meta'

export type CopyWorktreeStore = Pick<
  Store,
  'getWorktreeMeta' | 'setWorktreeMeta' | 'getAllWorktreeMeta'
>

/**
 * The copy's counterpart of the project folder: the copy root itself, or the same subfolder inside it
 * when the project is a folder below the client root. Paths follow the host's rules (Windows or
 * macOS), which need not be this computer's.
 */
export function copyWorktreePath(repo: Repo, sourceRoot: string, copyRoot: string): string {
  const path = isWindowsAbsolutePathLike(sourceRoot) ? win32 : posix
  const inside = path.relative(sourceRoot, repo.path)
  return inside && !inside.startsWith('..') ? path.join(copyRoot, inside) : copyRoot
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
    store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), {
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
      store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), {
        perforceStream: copy.stream
      })
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

/**
 * Syncs the copies of each folder project whose Perforce copy layout holds `path`, so a copy another
 * tool made since the last sync can be addressed by its folder at once. A folder that is not a
 * Perforce workspace fails its sync, and a failed sync counts as nothing adopted, which leaves the
 * caller's not-found answer standing.
 */
export async function adoptCopyAtPath(
  path: string,
  repos: readonly Repo[],
  syncCopies: (repo: Repo) => Promise<unknown>
): Promise<boolean> {
  const source = getPerforceCopySourcePath(path)
  if (!source) {
    return false
  }
  const owners = repos.filter(
    (repo) =>
      isFolderRepo(repo) &&
      win32.normalize(repo.path).toLowerCase() === win32.normalize(source).toLowerCase()
  )
  let adopted = false
  for (const repo of owners) {
    const synced = await syncCopies(repo).then(
      () => true,
      () => false
    )
    adopted ||= synced
  }
  return adopted
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
