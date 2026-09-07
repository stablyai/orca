import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceWorktree
} from '../shared/workspace-space-types'
import {
  readSidecarSnapshot,
  sidecarSnapshotFile,
  withSidecarSnapshotQueue,
  writeSidecarSnapshot
} from './sidecar-snapshot-file'
import type { ExecutionHostId } from '../shared/execution-host'
import {
  activeWorkspaceSnapshotPruneKeys,
  registerWorkspaceSnapshotPrunesForFile,
  workspaceSnapshotPruneKey,
  workspaceSnapshotPruneTargetKeys,
  type WorkspaceSnapshotPruneTarget,
  type WorkspaceSnapshotPruneTombstone
} from './workspace-snapshot-prune-index'

const SNAPSHOT_FILE_NAME = 'orca-workspace-space-analysis.json'
const SNAPSHOT_VERSION = 2

export type WorkspaceSpaceAnalysisSnapshotPruneTarget = WorkspaceSnapshotPruneTarget

const prunedWorkspacesByFile = new Map<string, Map<string, WorkspaceSnapshotPruneTombstone>>()

type PersistedWorkspaceSpaceAnalysisSnapshot = {
  version: number
  analysis: WorkspaceSpaceAnalysis
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPersistableWorktreeRow(value: unknown): value is WorkspaceSpaceWorktree {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.worktreeId === 'string' &&
    typeof value.repoId === 'string' &&
    (value.executionHostId === undefined || typeof value.executionHostId === 'string') &&
    typeof value.status === 'string' &&
    typeof value.sizeBytes === 'number' &&
    typeof value.reclaimableBytes === 'number' &&
    Array.isArray(value.topLevelItems)
  )
}

/** Shape guard so a corrupt persisted blob degrades to null instead of throwing at startup. */
function parseSnapshot(parsed: unknown): WorkspaceSpaceAnalysis | null {
  if (!isRecord(parsed) || parsed.version !== SNAPSHOT_VERSION) {
    return null
  }
  const analysis = parsed.analysis
  if (!isRecord(analysis)) {
    return null
  }
  if (
    typeof analysis.scannedAt !== 'number' ||
    typeof analysis.totalSizeBytes !== 'number' ||
    !Array.isArray(analysis.repos) ||
    !Array.isArray(analysis.worktrees) ||
    !analysis.worktrees.every(isPersistableWorktreeRow)
  ) {
    return null
  }
  return analysis as unknown as WorkspaceSpaceAnalysis
}

// Why strip topLevelItems: 500+ worktrees x 48 items is a multi-MB blob, and the cached view only
// needs per-worktree totals. Fold the items into the omitted counters so each row stays consistent.
function stripTopLevelItems(analysis: WorkspaceSpaceAnalysis): WorkspaceSpaceAnalysis {
  return {
    ...analysis,
    worktrees: analysis.worktrees.map((row) => ({
      ...row,
      topLevelItems: [],
      omittedTopLevelItemCount: row.omittedTopLevelItemCount + row.topLevelItems.length,
      omittedTopLevelSizeBytes:
        row.omittedTopLevelSizeBytes +
        row.topLevelItems.reduce((sum, item) => sum + item.sizeBytes, 0)
    }))
  }
}

export async function readWorkspaceSpaceAnalysisSnapshot(
  snapshotDirectory: string
): Promise<WorkspaceSpaceAnalysis | null> {
  try {
    return parseSnapshot(
      await readSidecarSnapshot(sidecarSnapshotFile(snapshotDirectory, SNAPSHOT_FILE_NAME))
    )
  } catch {
    return null
  }
}

async function writeSnapshot(file: string, analysis: WorkspaceSpaceAnalysis): Promise<void> {
  await writeSidecarSnapshot(file, {
    version: SNAPSHOT_VERSION,
    analysis
  } satisfies PersistedWorkspaceSpaceAnalysisSnapshot)
}

/** Persist a completed analysis. Never throws — the snapshot is a refetchable cache. */
export async function persistWorkspaceSpaceAnalysisSnapshot(
  snapshotDirectory: string,
  analysis: WorkspaceSpaceAnalysis
): Promise<void> {
  const file = sidecarSnapshotFile(snapshotDirectory, SNAPSHOT_FILE_NAME)
  try {
    await withSidecarSnapshotQueue(file, async () => {
      await writeSnapshot(file, stripTopLevelItems(excludeRowsPrunedDuringScan(file, analysis)))
      clearSupersededPrunes(file, analysis)
    })
  } catch (error) {
    console.warn('[workspace-space] failed to persist analysis snapshot:', error)
  }
}

function withoutWorktreeRows(
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

function analysisRepoKey(entry: { repoId: string; executionHostId?: ExecutionHostId }): string {
  return JSON.stringify([entry.executionHostId, entry.repoId])
}

/** Register anti-resurrection tombstones without scheduling a sidecar rewrite. */
export function registerWorkspaceSpaceAnalysisSnapshotPruneTombstones(
  snapshotDirectory: string,
  targets: readonly WorkspaceSpaceAnalysisSnapshotPruneTarget[]
): void {
  if (targets.length === 0) {
    return
  }
  registerWorkspaceSnapshotPrunesForFile(
    prunedWorkspacesByFile,
    sidecarSnapshotFile(snapshotDirectory, SNAPSHOT_FILE_NAME),
    targets
  )
}

function excludeRowsPrunedDuringScan(
  file: string,
  analysis: WorkspaceSpaceAnalysis
): WorkspaceSpaceAnalysis {
  const prunedKeys = activeWorkspaceSnapshotPruneKeys(
    prunedWorkspacesByFile.get(file),
    analysis.scannedAt
  )
  return withoutWorktreeRows(
    analysis,
    (row) =>
      prunedKeys.has(workspaceSnapshotPruneKey(row.worktreeId, row.executionHostId)) ||
      prunedKeys.has(workspaceSnapshotPruneKey(row.worktreeId))
  )
}

function clearSupersededPrunes(file: string, analysis: WorkspaceSpaceAnalysis): void {
  const pruned = prunedWorkspacesByFile.get(file)
  if (!pruned) {
    return
  }
  for (const [key, entry] of pruned) {
    if (entry.prunedAt < analysis.scannedAt) {
      pruned.delete(key)
    }
  }
  if (pruned.size === 0) {
    prunedWorkspacesByFile.delete(file)
  }
}

async function pruneWorkspaceSpaceAnalysisSnapshotsWithRegisteredTombstones(
  snapshotDirectory: string,
  targets: readonly WorkspaceSpaceAnalysisSnapshotPruneTarget[],
  registerTombstones: boolean
): Promise<void> {
  if (targets.length === 0) {
    return
  }
  const file = sidecarSnapshotFile(snapshotDirectory, SNAPSHOT_FILE_NAME)
  const targetKeys = workspaceSnapshotPruneTargetKeys(targets)
  if (registerTombstones) {
    registerWorkspaceSnapshotPrunesForFile(prunedWorkspacesByFile, file, targets)
  }
  try {
    await withSidecarSnapshotQueue(file, async () => {
      const registered = prunedWorkspacesByFile.get(file)
      const coalescedTargetKeys = registerTombstones
        ? targetKeys
        : new Set([...targetKeys].filter((key) => registered?.has(key)))
      if (coalescedTargetKeys.size === 0) {
        return
      }
      const existing = await readWorkspaceSpaceAnalysisSnapshot(snapshotDirectory)
      if (!existing) {
        return
      }
      const next = withoutWorktreeRows(
        existing,
        (row) =>
          coalescedTargetKeys.has(workspaceSnapshotPruneKey(row.worktreeId, row.executionHostId)) ||
          coalescedTargetKeys.has(workspaceSnapshotPruneKey(row.worktreeId))
      )
      if (next === existing) {
        return
      }
      await writeSnapshot(file, next)
    })
  } catch (error) {
    console.warn('[workspace-space] failed to prune analysis snapshot:', error)
  }
}

/** Drop removed workspace rows and rebalance their totals in one sidecar transaction. Never throws. */
export async function pruneWorkspaceSpaceAnalysisSnapshots(
  snapshotDirectory: string,
  targets: readonly WorkspaceSpaceAnalysisSnapshotPruneTarget[]
): Promise<void> {
  await pruneWorkspaceSpaceAnalysisSnapshotsWithRegisteredTombstones(
    snapshotDirectory,
    targets,
    true
  )
}

/** Flush only tombstones still active for this batch, preserving their original prune time. */
export async function finalizeWorkspaceSpaceAnalysisSnapshotPrunes(
  snapshotDirectory: string,
  targets: readonly WorkspaceSpaceAnalysisSnapshotPruneTarget[]
): Promise<void> {
  await pruneWorkspaceSpaceAnalysisSnapshotsWithRegisteredTombstones(
    snapshotDirectory,
    targets,
    false
  )
}

/** Drop one removed workspace row and rebalance the totals it contributed. Never throws. */
export async function pruneWorkspaceSpaceAnalysisSnapshot(
  snapshotDirectory: string,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Promise<void> {
  await pruneWorkspaceSpaceAnalysisSnapshots(snapshotDirectory, [{ worktreeId, executionHostId }])
}
