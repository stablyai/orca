import { basename } from 'node:path'
import { getRepoExecutionHostId, normalizeExecutionHostId } from '../../shared/execution-host'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  applyWorkspaceCleanupPolicy,
  createWorkspaceCleanupFingerprint,
  type WorkspaceCleanupCandidate
} from '../../shared/workspace-cleanup'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import {
  getNewestWorkspaceCleanupDiffCommentAt,
  getWorkspaceCleanupInactivityReasonsForWorkspace,
  isWorkspaceInactiveForCleanup
} from './workspace-cleanup-candidate'
import { getRepoOwnedWorktreeMeta, isWorktreeMetaOwnedByRepo } from '../worktree-metadata-ownership'
import {
  readAllWorktreeMetaForHost,
  readWorktreeMetaForHost
} from '../persistence/host-qualified-worktree-meta'

export function synthesizeDisconnectedSshCleanupCandidates(
  store: Store,
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
    // Why: targeted refreshes name their workspaces already; walking all
    // persisted metadata is unnecessary for disconnected SSH repos.
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
    if (!meta || (!includeAllWorkspaces && !isWorkspaceInactiveForCleanup(meta, scannedAt))) {
      continue
    }
    candidates.push(createDisconnectedSshCandidate(repo, scannedAt, worktreeId, meta))
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
  const reasons = getWorkspaceCleanupInactivityReasonsForWorkspace(meta, scannedAt)
  return applyWorkspaceCleanupPolicy({
    worktreeId,
    repoId: repo.id,
    repoName: repo.displayName,
    connectionId: repo.connectionId ?? null,
    executionHostId: normalizeExecutionHostId(meta.hostId) ?? getRepoExecutionHostId(repo),
    displayName: meta.displayName || basename(path),
    branch: basename(path),
    path,
    reasons,
    blockers: ['ssh-disconnected'],
    lastActivityAt: meta.lastActivityAt,
    ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: meta.diffComments?.length ?? 0,
      newestDiffCommentAt: getNewestWorkspaceCleanupDiffCommentAt(meta.diffComments),
      retainedDoneAgentCount: 0
    },
    git: {
      clean: null,
      upstreamAhead: null,
      upstreamBehind: null,
      checkedAt: null
    },
    fingerprint: createWorkspaceCleanupFingerprint({
      branch: basename(path),
      head: '',
      gitClean: null,
      lastActivityAt: meta.lastActivityAt
    })
  })
}
