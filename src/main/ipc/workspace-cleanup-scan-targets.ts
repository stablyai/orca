import { splitWorktreeId } from '../../shared/worktree/id'
import {
  WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT,
  type WorkspaceCleanupScanArgs
} from '../../shared/workspace-cleanup'

export function hasTargetedWorkspaceCleanupScan(args: WorkspaceCleanupScanArgs): boolean {
  return typeof args.worktreeId === 'string' || Array.isArray(args.worktreeIds)
}

export function getTargetWorktreeIdsByRepo(
  args: WorkspaceCleanupScanArgs
): Map<string, Set<string>> {
  const requestedIds = args.worktreeId
    ? [args.worktreeId]
    : (args.worktreeIds ?? []).slice(0, WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT)
  const idsByRepo = new Map<string, Set<string>>()
  for (const worktreeId of requestedIds) {
    if (typeof worktreeId !== 'string') {
      continue
    }
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed) {
      continue
    }
    const repoIds = idsByRepo.get(parsed.repoId) ?? new Set<string>()
    repoIds.add(worktreeId)
    idsByRepo.set(parsed.repoId, repoIds)
  }
  return idsByRepo
}
