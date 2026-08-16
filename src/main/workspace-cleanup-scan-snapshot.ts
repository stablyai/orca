import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanResult
} from '../shared/workspace-cleanup'
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

const SNAPSHOT_FILE_NAME = 'orca-workspace-cleanup-scan.json'
const SNAPSHOT_VERSION = 2

export type WorkspaceCleanupScanSnapshotPruneTarget = WorkspaceSnapshotPruneTarget

const prunedWorkspacesByFile = new Map<string, Map<string, WorkspaceSnapshotPruneTombstone>>()

type PersistedWorkspaceCleanupScanSnapshot = {
  version: number
  argsFingerprint: string
  result: WorkspaceCleanupScanResult
}

/** Why a fingerprint: a classifier bump reshuffles tiers/blockers wholesale, so an older snapshot must read as absent, not stale-but-plausible. */
export function workspaceCleanupScanSnapshotFingerprint(): string {
  return `classifier:${WORKSPACE_CLEANUP_CLASSIFIER_VERSION}|includeAllWorkspaces`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPersistableCandidate(value: unknown): value is WorkspaceCleanupCandidate {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.worktreeId === 'string' &&
    typeof value.repoId === 'string' &&
    typeof value.fingerprint === 'string' &&
    (value.connectionId === null || typeof value.connectionId === 'string') &&
    typeof value.executionHostId === 'string' &&
    Array.isArray(value.reasons) &&
    Array.isArray(value.blockers) &&
    isRecord(value.git) &&
    isRecord(value.localContext)
  )
}

/** Shape guard so a corrupt persisted blob degrades to null instead of throwing at startup. */
function parseSnapshot(parsed: unknown): WorkspaceCleanupScanResult | null {
  if (!isRecord(parsed)) {
    return null
  }
  if (parsed.version !== SNAPSHOT_VERSION) {
    return null
  }
  if (parsed.argsFingerprint !== workspaceCleanupScanSnapshotFingerprint()) {
    return null
  }
  const result = parsed.result
  if (!isRecord(result)) {
    return null
  }
  if (
    typeof result.scannedAt !== 'number' ||
    !Array.isArray(result.candidates) ||
    !Array.isArray(result.errors) ||
    !result.candidates.every(isPersistableCandidate)
  ) {
    return null
  }
  return result as unknown as WorkspaceCleanupScanResult
}

export async function readWorkspaceCleanupScanSnapshot(
  snapshotDirectory: string
): Promise<WorkspaceCleanupScanResult | null> {
  try {
    return parseSnapshot(
      await readSidecarSnapshot(sidecarSnapshotFile(snapshotDirectory, SNAPSHOT_FILE_NAME))
    )
  } catch {
    return null
  }
}

async function writeSnapshot(file: string, result: WorkspaceCleanupScanResult): Promise<void> {
  await writeSidecarSnapshot(file, {
    version: SNAPSHOT_VERSION,
    argsFingerprint: workspaceCleanupScanSnapshotFingerprint(),
    result
  } satisfies PersistedWorkspaceCleanupScanSnapshot)
}

function patchCandidates(
  existing: WorkspaceCleanupScanResult,
  fresh: WorkspaceCleanupCandidate[]
): WorkspaceCleanupScanResult {
  const freshById = new Map(fresh.map((candidate) => [candidateSnapshotKey(candidate), candidate]))
  const candidates = existing.candidates.map((candidate) => {
    const key = candidateSnapshotKey(candidate)
    const replacement = freshById.get(key)
    freshById.delete(key)
    return replacement ?? candidate
  })
  candidates.push(...freshById.values())
  // Why keep scannedAt: it marks the last FULL scan; a focused rescan must not advertise fleet-wide freshness.
  return { ...existing, candidates }
}

function candidateSnapshotKey(
  candidate: Pick<WorkspaceCleanupCandidate, 'executionHostId' | 'worktreeId'>
): string {
  return `${candidate.executionHostId ?? 'local'}\0${candidate.worktreeId}`
}

/** Register anti-resurrection tombstones without scheduling a sidecar rewrite. */
export function registerWorkspaceCleanupScanSnapshotPruneTombstones(
  snapshotDirectory: string,
  targets: readonly WorkspaceCleanupScanSnapshotPruneTarget[]
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
  result: WorkspaceCleanupScanResult
): WorkspaceCleanupScanResult {
  const prunedKeys = activeWorkspaceSnapshotPruneKeys(
    prunedWorkspacesByFile.get(file),
    result.scannedAt
  )
  if (prunedKeys.size === 0) {
    return result
  }
  const candidates = result.candidates.filter(
    (candidate) =>
      !prunedKeys.has(workspaceSnapshotPruneKey(candidate.worktreeId, candidate.executionHostId)) &&
      !prunedKeys.has(workspaceSnapshotPruneKey(candidate.worktreeId))
  )
  return candidates.length === result.candidates.length ? result : { ...result, candidates }
}

function clearSupersededPrunes(
  file: string,
  result: WorkspaceCleanupScanResult,
  broad: boolean
): void {
  const pruned = prunedWorkspacesByFile.get(file)
  if (!pruned) {
    return
  }
  const candidateKeys = broad
    ? undefined
    : new Set(
        result.candidates.flatMap((candidate) => [
          workspaceSnapshotPruneKey(candidate.worktreeId, candidate.executionHostId),
          workspaceSnapshotPruneKey(candidate.worktreeId)
        ])
      )
  for (const [key, entry] of pruned) {
    if (entry.prunedAt < result.scannedAt && (broad || candidateKeys?.has(key))) {
      pruned.delete(key)
    }
  }
  if (pruned.size === 0) {
    prunedWorkspacesByFile.delete(file)
  }
}

/**
 * Persist a completed scan: a broad (includeAllWorkspaces) scan replaces the snapshot, anything
 * narrower patches matching rows into it. Never throws — the snapshot is a refetchable cache.
 */
// Why: skip the full snapshot read whose only purpose is the scannedAt
// comparison — on a large fleet that read is a multi-hundred-KB synchronous
// JSON.parse per scan.
const lastPersistedScannedAtByFile = new Map<string, number>()

export async function persistWorkspaceCleanupScanResult(
  snapshotDirectory: string,
  args: WorkspaceCleanupScanArgs,
  result: WorkspaceCleanupScanResult
): Promise<void> {
  const file = sidecarSnapshotFile(snapshotDirectory, SNAPSHOT_FILE_NAME)
  try {
    await withSidecarSnapshotQueue(file, async () => {
      const filteredResult = excludeRowsPrunedDuringScan(file, result)
      // worktreeIds (even empty) is a targeted scan; persisting it as broad
      // would replace the fleet snapshot with a subset.
      const broad =
        !args.worktreeId && !Array.isArray(args.worktreeIds) && args.includeAllWorkspaces === true
      if (broad) {
        let knownScannedAt = lastPersistedScannedAtByFile.get(file)
        if (knownScannedAt === undefined) {
          const existing = await readWorkspaceCleanupScanSnapshot(snapshotDirectory)
          knownScannedAt = existing?.scannedAt
        }
        if (knownScannedAt !== undefined && knownScannedAt > filteredResult.scannedAt) {
          lastPersistedScannedAtByFile.set(file, knownScannedAt)
          return
        }
        await writeSnapshot(file, filteredResult)
        lastPersistedScannedAtByFile.set(file, filteredResult.scannedAt)
        clearSupersededPrunes(file, result, true)
        return
      }
      if (filteredResult.candidates.length === 0) {
        return
      }
      const existing = await readWorkspaceCleanupScanSnapshot(snapshotDirectory)
      // Why: a focused/legacy scan is a subset; without a broad baseline it is not a fleet snapshot.
      if (!existing) {
        return
      }
      await writeSnapshot(file, patchCandidates(existing, filteredResult.candidates))
      clearSupersededPrunes(file, result, false)
    })
  } catch (error) {
    console.warn('[workspace-cleanup] failed to persist scan snapshot:', error)
  }
}

async function pruneWorkspaceCleanupScanSnapshotsWithRegisteredTombstones(
  snapshotDirectory: string,
  targets: readonly WorkspaceCleanupScanSnapshotPruneTarget[],
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
      const existing = await readWorkspaceCleanupScanSnapshot(snapshotDirectory)
      if (!existing) {
        return
      }
      const candidates = existing.candidates.filter(
        (candidate) =>
          !coalescedTargetKeys.has(
            workspaceSnapshotPruneKey(candidate.worktreeId, candidate.executionHostId)
          ) && !coalescedTargetKeys.has(workspaceSnapshotPruneKey(candidate.worktreeId))
      )
      if (candidates.length === existing.candidates.length) {
        return
      }
      await writeSnapshot(file, { ...existing, candidates })
    })
  } catch (error) {
    console.warn('[workspace-cleanup] failed to prune scan snapshot:', error)
  }
}

/** Drop removed workspaces in one sidecar transaction. Never throws. */
export async function pruneWorkspaceCleanupScanSnapshots(
  snapshotDirectory: string,
  targets: readonly WorkspaceCleanupScanSnapshotPruneTarget[]
): Promise<void> {
  await pruneWorkspaceCleanupScanSnapshotsWithRegisteredTombstones(snapshotDirectory, targets, true)
}

/** Flush only tombstones still active for this batch, preserving their original prune time. */
export async function finalizeWorkspaceCleanupScanSnapshotPrunes(
  snapshotDirectory: string,
  targets: readonly WorkspaceCleanupScanSnapshotPruneTarget[]
): Promise<void> {
  await pruneWorkspaceCleanupScanSnapshotsWithRegisteredTombstones(
    snapshotDirectory,
    targets,
    false
  )
}

/** Drop a removed workspace so it never resurrects from cache. Never throws. */
export async function pruneWorkspaceCleanupScanSnapshot(
  snapshotDirectory: string,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Promise<void> {
  await pruneWorkspaceCleanupScanSnapshots(snapshotDirectory, [{ worktreeId, executionHostId }])
}
