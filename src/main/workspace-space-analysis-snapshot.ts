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
  workspaceSnapshotPruneKey,
  workspaceSnapshotPruneTargetKeys,
  type WorkspaceSnapshotPruneTarget
} from './workspace-snapshot-prune-index'
import {
  createWorkspaceSnapshotPruneTombstoneRegistry,
  type WorkspaceSnapshotPruneProducerToken
} from './workspace-snapshot-prune-tombstone-holders'
import { withoutWorktreeRows } from './workspace-space-analysis-row-pruning'

const SNAPSHOT_FILE_NAME = 'orca-workspace-space-analysis.json'
const SNAPSHOT_VERSION = 2

export type WorkspaceSpaceAnalysisSnapshotPruneTarget = WorkspaceSnapshotPruneTarget

const tombstoneRegistry = createWorkspaceSnapshotPruneTombstoneRegistry((directory) =>
  sidecarSnapshotFile(directory, SNAPSHOT_FILE_NAME)
)

/** Run every analysis that may persist to this sidecar inside the fence — the only source of a token. */
export const withWorkspaceSpaceAnalysisSnapshotProducer = tombstoneRegistry.withProducer

/** Retention probe: STA-4451 is about how many tombstones survive, not just which rows they hide. */
export const workspaceSpaceAnalysisSnapshotTombstoneCountForTests = (
  snapshotDirectory: string
): number => tombstoneRegistry.count(sidecarSnapshotFile(snapshotDirectory, SNAPSHOT_FILE_NAME))

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
  analysis: WorkspaceSpaceAnalysis,
  producer: WorkspaceSnapshotPruneProducerToken
): Promise<void> {
  const file = sidecarSnapshotFile(snapshotDirectory, SNAPSHOT_FILE_NAME)
  const endWrite = producer.beginWrite(file)
  if (!endWrite) {
    // The producer was bounded out, so its tombstones have already retired. Writing now is exactly
    // the resurrection they existed to prevent — drop this result instead.
    return
  }
  try {
    await withSidecarSnapshotQueue(file, async () => {
      await writeSnapshot(
        file,
        stripTopLevelItems(excludeRowsPrunedDuringScan(file, analysis, producer.seq))
      )
    })
  } catch (error) {
    console.warn('[workspace-space] failed to persist analysis snapshot:', error)
  } finally {
    endWrite()
  }
}

/** Register anti-resurrection tombstones without scheduling a sidecar rewrite. */
export function registerWorkspaceSpaceAnalysisSnapshotPruneTombstones(
  snapshotDirectory: string,
  targets: readonly WorkspaceSpaceAnalysisSnapshotPruneTarget[]
): void {
  if (targets.length === 0) {
    return
  }
  // Deferred: the flush is a holder too, or a settling producer would retire the tombstone before
  // finalize runs and finalize would skip the sidecar rewrite it was tombstoned for.
  tombstoneRegistry.register(
    sidecarSnapshotFile(snapshotDirectory, SNAPSHOT_FILE_NAME),
    targets,
    true
  )
}

function excludeRowsPrunedDuringScan(
  file: string,
  analysis: WorkspaceSpaceAnalysis,
  producerSeq: number
): WorkspaceSpaceAnalysis {
  const prunedKeys = activeWorkspaceSnapshotPruneKeys(
    tombstoneRegistry.tombstones(file),
    producerSeq
  )
  return withoutWorktreeRows(
    analysis,
    (row) =>
      prunedKeys.has(workspaceSnapshotPruneKey(row.worktreeId, row.executionHostId)) ||
      prunedKeys.has(workspaceSnapshotPruneKey(row.worktreeId))
  )
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
    // Immediate: no flush holder, this call performs the sidecar rewrite itself.
    tombstoneRegistry.register(file, targets, false)
  }
  try {
    await withSidecarSnapshotQueue(file, async () => {
      const registered = tombstoneRegistry.tombstones(file)
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
  } finally {
    if (!registerTombstones) {
      tombstoneRegistry.releaseFlush(file, targetKeys)
    }
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
