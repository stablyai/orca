import { basename } from 'node:path'
import { getRepoExecutionHostId, normalizeExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { WorkspaceCleanupCandidate } from '../../../shared/workspace-cleanup/workspace-cleanup'
import { createUnreachableHostCleanupCandidate } from '../../../shared/workspace-cleanup/workspace-cleanup-unreachable-host-candidate'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import {
  getRepoOwnedWorktreeMeta,
  isWorktreeMetaOwnedByRepo
} from '../../workspaces/catalog/worktree-metadata-ownership'
import {
  readAllWorktreeMetaForHost,
  readWorktreeMetaForHost
} from '../../persistence/host-qualified-worktree-meta'

export function synthesizeDisconnectedSshCleanupCandidates(
  store: RuntimeStore,
  repo: Repo,
  scannedAt: number,
  repoOwnerCount: number,
  targetWorktreeIds?: ReadonlySet<string>,
  includeAllWorkspaces = false
): WorkspaceCleanupCandidate[] {
  const repoWorktreePrefix = `${repo.id}::`
  const executionHostId = getRepoExecutionHostId(repo)
  if (targetWorktreeIds) {
    const candidates: WorkspaceCleanupCandidate[] = []
    // Targeted refresh already names candidates; avoid traversing all persisted SSH metadata.
    for (const worktreeId of targetWorktreeIds) {
      if (!worktreeId.startsWith(repoWorktreePrefix)) {
        continue
      }
      const meta =
        readWorktreeMetaForHost(store, worktreeId, executionHostId) ??
        (typeof store.getWorktreeMetaForHost === 'function'
          ? undefined
          : store.getWorktreeMeta(worktreeId))
      if (isWorktreeMetaOwnedByRepo(repo, meta, repoOwnerCount)) {
        candidates.push(createDisconnectedSshCandidate(repo, scannedAt, worktreeId, meta))
      }
    }
    return candidates
  }

  const candidates: WorkspaceCleanupCandidate[] = []
  const allMeta = readAllWorktreeMetaForHost(store, executionHostId)
  for (const worktreeId in allMeta) {
    if (!Object.hasOwn(allMeta, worktreeId) || !worktreeId.startsWith(repoWorktreePrefix)) {
      continue
    }
    const meta = getRepoOwnedWorktreeMeta(repo, worktreeId, allMeta, repoOwnerCount)
    const candidate = meta && createDisconnectedSshCandidate(repo, scannedAt, worktreeId, meta)
    if (candidate && (includeAllWorkspaces || candidate.reasons.length > 0)) {
      candidates.push(candidate)
    }
  }
  return candidates
}

function createDisconnectedSshCandidate(
  repo: Repo,
  scannedAt: number,
  worktreeId: string,
  meta: WorktreeMeta
): WorkspaceCleanupCandidate {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const path = parsed?.worktreePath ?? worktreeId
  return createUnreachableHostCleanupCandidate(
    repo,
    normalizeExecutionHostId(meta.hostId) ?? getRepoExecutionHostId(repo),
    {
      ...meta,
      worktreeId,
      path,
      displayName: meta.displayName || basename(path),
      branch: basename(path)
    },
    scannedAt
  )
}
