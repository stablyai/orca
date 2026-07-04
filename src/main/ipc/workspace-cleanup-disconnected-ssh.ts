import { basename } from 'node:path'
import type { Store } from '../persistence'
import type { Repo, WorktreeMeta } from '../../shared/types'
import {
  applyWorkspaceCleanupPolicy,
  createWorkspaceCleanupFingerprint,
  type WorkspaceCleanupCandidate
} from '../../shared/workspace-cleanup'
import { splitWorktreeId } from '../../shared/worktree-id'
import {
  getNewestWorkspaceCleanupDiffCommentAt,
  getWorkspaceCleanupInactivityReasonsForWorkspace,
  isWorkspaceInactiveForCleanup
} from './workspace-cleanup-candidate'

export function synthesizeDisconnectedSshCleanupCandidates(
  store: Store,
  repo: Repo,
  scannedAt: number,
  targetWorktreeId?: string
): WorkspaceCleanupCandidate[] {
  const repoWorktreePrefix = `${repo.id}::`
  if (targetWorktreeId) {
    if (!targetWorktreeId.startsWith(repoWorktreePrefix)) {
      return []
    }
    // Why: focused delete preflight names one workspace already; walking all
    // persisted metadata is unnecessary for disconnected SSH repos.
    const meta = store.getWorktreeMeta(targetWorktreeId)
    return meta ? [createDisconnectedSshCandidate(repo, scannedAt, targetWorktreeId, meta)] : []
  }

  const candidates: WorkspaceCleanupCandidate[] = []
  const allMeta = store.getAllWorktreeMeta()
  for (const worktreeId in allMeta) {
    if (!Object.hasOwn(allMeta, worktreeId) || !worktreeId.startsWith(repoWorktreePrefix)) {
      continue
    }
    const meta = allMeta[worktreeId]
    if (!meta || !isWorkspaceInactiveForCleanup(meta, scannedAt)) {
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
  const parsed = splitWorktreeId(worktreeId)
  const path = parsed?.worktreePath ?? worktreeId
  const reasons = getWorkspaceCleanupInactivityReasonsForWorkspace(meta, scannedAt)
  return applyWorkspaceCleanupPolicy({
    worktreeId,
    repoId: repo.id,
    repoName: repo.displayName,
    connectionId: repo.connectionId ?? null,
    displayName: meta.displayName || basename(path),
    branch: basename(path),
    path,
    tier: 'protected',
    selectedByDefault: false,
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
