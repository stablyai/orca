import type { ExecutionHostId } from '../shared/execution-host'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceWorktree
} from '../shared/workspace-space-types'

function analysisRepoKey(entry: { repoId: string; executionHostId?: ExecutionHostId }): string {
  return JSON.stringify([entry.executionHostId, entry.repoId])
}

export function withoutWorktreeRows(
  analysis: WorkspaceSpaceAnalysis,
  shouldRemove: (row: WorkspaceSpaceWorktree) => boolean
): WorkspaceSpaceAnalysis {
  const worktrees: WorkspaceSpaceWorktree[] = []
  const removedByRepo = new Map<
    string,
    {
      worktreeCount: number
      scannedWorktreeCount: number
      unavailableWorktreeCount: number
      totalSizeBytes: number
      reclaimableBytes: number
    }
  >()
  let removedCount = 0
  let scannedDelta = 0
  let unavailableDelta = 0
  let totalSizeDelta = 0
  let reclaimableDelta = 0
  for (const row of analysis.worktrees) {
    if (!shouldRemove(row)) {
      worktrees.push(row)
      continue
    }
    const scanned = row.status === 'ok' ? 1 : 0
    const unavailable = row.status === 'ok' ? 0 : 1
    removedCount += 1
    scannedDelta += scanned
    unavailableDelta += unavailable
    totalSizeDelta += row.sizeBytes
    reclaimableDelta += row.reclaimableBytes
    const key = analysisRepoKey(row)
    const delta = removedByRepo.get(key) ?? {
      worktreeCount: 0,
      scannedWorktreeCount: 0,
      unavailableWorktreeCount: 0,
      totalSizeBytes: 0,
      reclaimableBytes: 0
    }
    delta.worktreeCount += 1
    delta.scannedWorktreeCount += scanned
    delta.unavailableWorktreeCount += unavailable
    delta.totalSizeBytes += row.sizeBytes
    delta.reclaimableBytes += row.reclaimableBytes
    removedByRepo.set(key, delta)
  }
  if (removedCount === 0) {
    return analysis
  }
  return {
    ...analysis,
    worktrees,
    worktreeCount: Math.max(0, analysis.worktreeCount - removedCount),
    scannedWorktreeCount: Math.max(0, analysis.scannedWorktreeCount - scannedDelta),
    unavailableWorktreeCount: Math.max(0, analysis.unavailableWorktreeCount - unavailableDelta),
    totalSizeBytes: Math.max(0, analysis.totalSizeBytes - totalSizeDelta),
    reclaimableBytes: Math.max(0, analysis.reclaimableBytes - reclaimableDelta),
    repos: analysis.repos.map((repo) => {
      const delta = removedByRepo.get(analysisRepoKey(repo))
      return delta
        ? {
            ...repo,
            worktreeCount: Math.max(0, repo.worktreeCount - delta.worktreeCount),
            scannedWorktreeCount: Math.max(
              0,
              repo.scannedWorktreeCount - delta.scannedWorktreeCount
            ),
            unavailableWorktreeCount: Math.max(
              0,
              repo.unavailableWorktreeCount - delta.unavailableWorktreeCount
            ),
            totalSizeBytes: Math.max(0, repo.totalSizeBytes - delta.totalSizeBytes),
            reclaimableBytes: Math.max(0, repo.reclaimableBytes - delta.reclaimableBytes)
          }
        : repo
    })
  }
}
