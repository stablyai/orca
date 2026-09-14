import type {
  WorkspaceCleanupSnapshotPruneBatchArgs,
  WorkspaceCleanupSnapshotPruneRecordArgs
} from '../shared/workspace-cleanup'
import {
  finalizeWorkspaceCleanupScanSnapshotPrunes,
  pruneWorkspaceCleanupScanSnapshots,
  registerWorkspaceCleanupScanSnapshotPruneTombstones
} from './workspace-cleanup-scan-snapshot'
import {
  finalizeWorkspaceSpaceAnalysisSnapshotPrunes,
  pruneWorkspaceSpaceAnalysisSnapshots,
  registerWorkspaceSpaceAnalysisSnapshotPruneTombstones
} from './workspace-space-analysis-snapshot'

type SnapshotPruneTarget = Omit<WorkspaceCleanupSnapshotPruneRecordArgs, 'batchId'>

type SnapshotPruneBatch = {
  targets: Map<string, SnapshotPruneTarget>
  expirationTimer?: ReturnType<typeof setTimeout>
}

const batches = new Map<string, SnapshotPruneBatch>()
const SNAPSHOT_PRUNE_BATCH_IDLE_TIMEOUT_MS = 5 * 60_000

function batchKey(snapshotDirectory: string, batchId: string): string {
  return `${snapshotDirectory}\0${batchId}`
}

function targetKey(target: SnapshotPruneTarget): string {
  return `${target.executionHostId ?? '*'}\0${target.worktreeId}`
}

function scheduleBatchExpiration(
  snapshotDirectory: string,
  batchId: string,
  batch: SnapshotPruneBatch
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    const expired = takeBatch(snapshotDirectory, batchId, batch)
    if (expired) {
      void finalizeBatch(snapshotDirectory, expired)
    }
  }, SNAPSHOT_PRUNE_BATCH_IDLE_TIMEOUT_MS)
  timer.unref()
  return timer
}

function takeBatch(
  snapshotDirectory: string,
  batchId: string,
  expected?: SnapshotPruneBatch
): SnapshotPruneBatch | undefined {
  const key = batchKey(snapshotDirectory, batchId)
  const batch = batches.get(key)
  if (!batch || (expected && batch !== expected)) {
    return undefined
  }
  batches.delete(key)
  if (batch.expirationTimer) {
    clearTimeout(batch.expirationTimer)
  }
  return batch
}

async function finalizeBatch(snapshotDirectory: string, batch: SnapshotPruneBatch): Promise<void> {
  const targets = [...batch.targets.values()]
  await Promise.all([
    finalizeWorkspaceCleanupScanSnapshotPrunes(snapshotDirectory, targets),
    finalizeWorkspaceSpaceAnalysisSnapshotPrunes(snapshotDirectory, targets)
  ])
}

export function beginWorkspaceCleanupRemovalSnapshotPruneBatch(
  snapshotDirectory: string,
  args: WorkspaceCleanupSnapshotPruneBatchArgs
): void {
  const key = batchKey(snapshotDirectory, args.batchId)
  const existing = batches.get(key)
  if (existing) {
    if (existing.expirationTimer) {
      clearTimeout(existing.expirationTimer)
    }
    existing.expirationTimer = scheduleBatchExpiration(snapshotDirectory, args.batchId, existing)
    return
  }
  const batch: SnapshotPruneBatch = { targets: new Map() }
  batch.expirationTimer = scheduleBatchExpiration(snapshotDirectory, args.batchId, batch)
  batches.set(key, batch)
}

/** Tombstone now; defer the two durable sidecar rewrites until the batch closes. */
export function recordWorkspaceCleanupRemovalSnapshotPrune(
  snapshotDirectory: string,
  args: WorkspaceCleanupSnapshotPruneRecordArgs
): void {
  const target = {
    worktreeId: args.worktreeId,
    ...(args.executionHostId ? { executionHostId: args.executionHostId } : {})
  }
  const batch = batches.get(batchKey(snapshotDirectory, args.batchId))
  if (!batch) {
    void pruneWorkspaceCleanupScanSnapshots(snapshotDirectory, [target])
    void pruneWorkspaceSpaceAnalysisSnapshots(snapshotDirectory, [target])
    return
  }

  const key = targetKey(target)
  if (!batch.targets.has(key)) {
    registerWorkspaceCleanupScanSnapshotPruneTombstones(snapshotDirectory, [target])
    registerWorkspaceSpaceAnalysisSnapshotPruneTombstones(snapshotDirectory, [target])
    batch.targets.set(key, target)
  }
  if (batch.expirationTimer) {
    clearTimeout(batch.expirationTimer)
  }
  batch.expirationTimer = scheduleBatchExpiration(snapshotDirectory, args.batchId, batch)
}

export async function finishWorkspaceCleanupRemovalSnapshotPruneBatch(
  snapshotDirectory: string,
  args: WorkspaceCleanupSnapshotPruneBatchArgs
): Promise<void> {
  const batch = takeBatch(snapshotDirectory, args.batchId)
  if (!batch) {
    return
  }
  await finalizeBatch(snapshotDirectory, batch)
}

export function resetWorkspaceCleanupRemovalSnapshotPruneBatchesForTests(): void {
  for (const batch of batches.values()) {
    if (batch.expirationTimer) {
      clearTimeout(batch.expirationTimer)
    }
  }
  batches.clear()
}
