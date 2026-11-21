import { posix, win32 } from 'node:path'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../shared/file-access/cross-platform-path'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import type { Repo } from '../../shared/repository/repo-types'
import type {
  WorkspaceCopyListEntry,
  WorkspaceCopyListResult
} from '../../shared/perforce/workspace-copy/workspace-copy-types'
import { splitWorktreeId } from '../../shared/worktree/id'
import {
  getPerforceCopyName,
  getPerforceCopySourcePaths,
  getPerforceCopyWorktreeId,
  isPerforceCopyWorktreeIdForRepo
} from '../../shared/worktree/perforce-copy-worktree'
import type { Store } from '../persistence/loading-store/store'
import {
  hostWorktreeTargetForRepo,
  readAllWorktreeMetaForRepo
} from '../persistence/host-qualified-worktree-meta'

// Why host-scoped reads: hosts sharing a repo id and copy path keep separate metadata rows.
export type CopyWorktreeStore = Pick<Store, 'setWorktreeMeta' | 'getAllWorktreeMeta'> &
  Partial<Pick<Store, 'getAllWorktreeMetaForHost'>>

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
  store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), {
    displayName: name,
    createdAt,
    orcaCreatedAt: createdAt,
    orcaCreationSource: getRepoSshConnectionId(repo) ? 'ssh' : 'desktop',
    lastActivityAt: createdAt
  })
}

function createdAtOf(copy: WorkspaceCopyListEntry): number {
  const parsed = copy.created ? Date.parse(copy.created) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/** A copy the sidebar shows: its folder exists, and so does its client when the server answered. */
function isUsableCopy(copy: WorkspaceCopyListEntry, listing: WorkspaceCopyListResult): boolean {
  return copy.folderExists && (copy.clientExists || !listing.serverChecked)
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
  const known = readAllWorktreeMetaForRepo(store, repo)
  const live = new Set<string>()
  for (const copy of listing.copies) {
    if (!isUsableCopy(copy, listing)) {
      continue
    }
    const path = copyWorktreePath(repo, listing.source.root, copy.copyRoot)
    const worktreeId = getPerforceCopyWorktreeId(repo, path)
    live.add(worktreeId)
    const existing = known[worktreeId]
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
  for (const worktreeId of Object.keys(known)) {
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

/** Syncs the folder project whose copy layout holds `path`; true when that adopted a copy there. */
export async function adoptCopyAtPath(
  path: string,
  repos: readonly Repo[],
  host: {
    requiredHostId?: ExecutionHostId
    folderExists: (path: string) => boolean
    syncCopies: (repo: Repo) => Promise<WorkspaceCopyListResult>
  }
): Promise<boolean> {
  const key = normalizeRuntimePathForComparison
  const sources = new Set(getPerforceCopySourcePaths(path).map(key))
  // Why: a mistyped or deleted copy would otherwise pay a full p4 listing on every lookup.
  if (sources.size === 0 || !host.folderExists(path)) {
    return false
  }
  let adopted = false
  for (const repo of repos) {
    const onHost =
      host.requiredHostId === undefined || getRepoExecutionHostId(repo) === host.requiredHostId
    if (!onHost || !isFolderRepo(repo) || !sources.has(key(repo.path))) {
      continue
    }
    try {
      const listing = await host.syncCopies(repo)
      adopted ||= listing.copies.some(
        (copy) =>
          isUsableCopy(copy, listing) &&
          key(copyWorktreePath(repo, listing.source.root, copy.copyRoot)) === key(path)
      )
    } catch (error) {
      console.warn('[perforce-copies] Copy sync for a path selector failed:', error)
    }
  }
  return adopted
}

/** Resolves `selector`; on a `path:` miss that `adopt` turns into a copy, resolves once more. */
export async function resolveWithCopyAdoption<T>(
  selector: string,
  resolve: () => Promise<T>,
  adopt: (path: string) => Promise<boolean>
): Promise<T> {
  try {
    return await resolve()
  } catch (error) {
    const missedPath =
      error instanceof Error &&
      error.message === 'selector_not_found' &&
      selector.startsWith('path:')
    if (!missedPath || !(await adopt(selector.slice(5)))) {
      throw error
    }
    return resolve()
  }
}

export function copyWorktreeIdForName(
  store: CopyWorktreeStore,
  repo: Repo,
  name: string
): { worktreeId: string; path: string } | null {
  for (const worktreeId of Object.keys(readAllWorktreeMetaForRepo(store, repo))) {
    const path = splitWorktreeId(worktreeId)?.worktreePath
    if (
      path &&
      isPerforceCopyWorktreeIdForRepo(repo, worktreeId) &&
      getPerforceCopyName(path, repo.path)?.toLowerCase() === name.toLowerCase()
    ) {
      return { worktreeId, path }
    }
  }
  return null
}
