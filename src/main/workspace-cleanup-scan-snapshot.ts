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
  workspaceSnapshotPruneKey,
  workspaceSnapshotPruneTargetKeys,
  type WorkspaceSnapshotPruneTarget
} from './workspace-snapshot-prune-index'
import {
  createWorkspaceSnapshotPruneTombstoneRegistry,
  type WorkspaceSnapshotPruneProducerToken
} from './workspace-snapshot-prune-tombstone-holders'

const SNAPSHOT_FILE_NAME = 'orca-workspace-cleanup-scan.json'
const SNAPSHOT_VERSION = 2

export type WorkspaceCleanupScanSnapshotPruneTarget = WorkspaceSnapshotPruneTarget

const tombstoneRegistry = createWorkspaceSnapshotPruneTombstoneRegistry((directory) =>
  sidecarSnapshotFile(directory, SNAPSHOT_FILE_NAME)
)

/** Run every scan that may persist to this sidecar inside the fence — the only source of a token. */
export const withWorkspaceCleanupScanSnapshotProducer = tombstoneRegistry.withProducer

/** Retention probe: STA-4451 is about how many tombstones survive, not just which rows they hide. */
export const workspaceCleanupScanSnapshotTombstoneCountForTests = (
  snapshotDirectory: string
): number => tombstoneRegistry.count(sidecarSnapshotFile(snapshotDirectory, SNAPSHOT_FILE_NAME))

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
  result: WorkspaceCleanupScanResult,
  producerSeq: number
): WorkspaceCleanupScanResult {
  const prunedKeys = activeWorkspaceSnapshotPruneKeys(
    tombstoneRegistry.tombstones(file),
    producerSeq
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
  result: WorkspaceCleanupScanResult,
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
      const filteredResult = excludeRowsPrunedDuringScan(file, result, producer.seq)
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
    })
  } catch (error) {
    console.warn('[workspace-cleanup] failed to persist scan snapshot:', error)
  } finally {
    endWrite()
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
  } finally {
    if (!registerTombstones) {
      tombstoneRegistry.releaseFlush(file, targetKeys)
    }
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
