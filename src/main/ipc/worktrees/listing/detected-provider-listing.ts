import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import { getSshGitProvider } from '../../../providers/ssh-git-dispatch'
import type { DetectedWorktreeListResult, GitWorktreeInfo } from '../../../../shared/worktree/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { projectResolvedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'
import { pruneLineageForMissingRepoWorktrees } from '../../../worktree-lineage-pruning'
import type { DirectSshDetectedWorktreeRequest } from '../../../../shared/detected-worktree-provider-contract'
import { isAdmissibleDirectSshAuthority } from '../../../../shared/ssh-retained-payload-admission'
import type { ListDesktopLineageForHostArgs } from '../../../../shared/host-lineage-contract'
import {
  buildDetectedGitWorktrees,
  createSshWorktreeMetaIndex,
  listDisconnectedSshWorktrees
} from './ssh-worktree-fallback'
import {
  buildDisconnectedDetectedWorktrees,
  buildFolderDetectedWorktrees
} from './folder-workspace-catalog'
import { isFolderWorkspaceIdForRepo } from '../folder-workspace-model'
import { hasConflictingStoredWorktreeOwner } from './worktree-host-ownership'
import {
  listDetectedGitWorktrees,
  rememberLocalWorktreeRoots
} from './detected-worktree-scan-cache'
import { loggedWorktreeListFailures, warnOnce } from './worktree-listing-diagnostics'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'

export async function listDetectedWorktreesForCapturedRepo(
  store: Store,
  repo: Repo,
  isCurrent: () => boolean,
  capturedProvider = repo.connectionId ? getSshGitProvider(repo.connectionId) : undefined,
  providerAbort?: { signal: AbortSignal; status: () => 'canceled' | 'timed-out' }
): Promise<DetectedWorktreeListResult | { providerAbortStatus: 'canceled' | 'timed-out' } | null> {
  const abortedResult = () =>
    providerAbort?.signal.aborted
      ? ({ providerAbortStatus: providerAbort.status() } as const)
      : undefined
  const allMeta = isFolderRepo(repo)
    ? undefined
    : readAllWorktreeMetaForHost(store, getRepoExecutionHostId(repo))
  const sshWorktreeMetaIndex = repo.connectionId
    ? createSshWorktreeMetaIndex(Object.entries(allMeta ?? {}))
    : new Map()

  try {
    let gitWorktrees: GitWorktreeInfo[]
    let freshScan = true
    if (isFolderRepo(repo)) {
      if (!isCurrent()) {
        return null
      }
      const folderWorkspaceIds = Object.keys(store.getAllWorktreeMeta()).filter((worktreeId) =>
        isFolderWorkspaceIdForRepo(repo, worktreeId)
      )
      if (hasConflictingStoredWorktreeOwner(store, repo, folderWorkspaceIds)) {
        return {
          repoId: repo.id,
          authoritative: false,
          source: 'metadata-fallback',
          worktrees: []
        }
      }
      return {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        worktrees: projectResolvedWorktreeLineage(
          buildFolderDetectedWorktrees(store, repo),
          store.getAllWorktreeLineage?.() ?? {}
        )
      }
    }
    if (repo.connectionId) {
      if (!capturedProvider) {
        const aborted = abortedResult()
        if (aborted) {
          return aborted
        }
        if (!isCurrent()) {
          return null
        }
        const worktrees = listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
        return {
          repoId: repo.id,
          authoritative: false,
          source: 'metadata-fallback',
          worktrees: buildDisconnectedDetectedWorktrees(store, repo, worktrees)
        }
      }
      gitWorktrees = await capturedProvider.listWorktrees(repo.path, {
        signal: providerAbort?.signal
      })
    } else {
      const scan = await listDetectedGitWorktrees(store, repo)
      gitWorktrees = scan.gitWorktrees
      freshScan = scan.fresh
    }
    const aborted = abortedResult()
    if (aborted) {
      return aborted
    }
    if (!isCurrent()) {
      return null
    }
    const listedWorktreeIds = gitWorktrees.map((worktree) => `${repo.id}::${worktree.path}`)
    if (hasConflictingStoredWorktreeOwner(store, repo, listedWorktreeIds)) {
      return {
        repoId: repo.id,
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: []
      }
    }
    if (freshScan) {
      rememberLocalWorktreeRoots(store, repo, gitWorktrees)
      pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
    }
    loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
    return {
      repoId: repo.id,
      authoritative: true,
      source: 'git',
      worktrees: buildDetectedGitWorktrees(store, repo, gitWorktrees, allMeta)
    }
  } catch (err) {
    const aborted = abortedResult()
    if (aborted) {
      return aborted
    }
    if (!isCurrent()) {
      return null
    }
    warnOnce(
      loggedWorktreeListFailures,
      `${repo.id}:${repo.path}`,
      `[worktrees] failed to list detected worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
      err
    )
    if (repo.connectionId) {
      const worktrees = listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
      return {
        repoId: repo.id,
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: buildDisconnectedDetectedWorktrees(store, repo, worktrees)
      }
    }
    return { repoId: repo.id, authoritative: false, source: 'metadata-fallback', worktrees: [] }
  }
}

export function hasValidDirectSshAuthority(
  args: DirectSshDetectedWorktreeRequest
): args is DirectSshDetectedWorktreeRequest {
  return isAdmissibleDirectSshAuthority(args.expectedAuthority)
}

export function hasValidLineageSshAuthority(
  args: ListDesktopLineageForHostArgs
): args is Extract<ListDesktopLineageForHostArgs, { expectedAuthority: unknown }> {
  if (!('expectedAuthority' in args)) {
    return false
  }
  return isAdmissibleDirectSshAuthority(args.expectedAuthority)
}
