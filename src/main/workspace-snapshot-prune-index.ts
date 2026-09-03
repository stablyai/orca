import type { ExecutionHostId } from '../shared/execution-host'

export type WorkspaceSnapshotPruneTarget = {
  worktreeId: string
  executionHostId?: ExecutionHostId
}

/**
 * `holders` is the retirement gate (STA-4451): the writers that could still resurrect this row.
 * `prunedSeq` orders this prune against the producers that were already running when it landed.
 */
export type WorkspaceSnapshotPruneTombstone = WorkspaceSnapshotPruneTarget & {
  prunedSeq: number
  holders: Set<string>
}

/**
 * Bounds a producer that never reports back — a scan wedged on an unreachable SSH host, or a
 * renderer torn down mid-scan. Deliberately longer than the removal batch's idle timeout so it can
 * never preempt a pending flush, which it does not police.
 */
export const WORKSPACE_SNAPSHOT_PRUNE_PRODUCER_TIMEOUT_MS = 10 * 60 * 1000

// Why not Date.now(): a sleep/resume or an NTP correction moves the wall clock while an in-flight
// scan's promise does not, which would order a prune against a producer that never advanced.
let lastSequence = 0

/** Process-lifetime ordering source for prunes and producer starts. */
export function nextWorkspaceSnapshotPruneSequence(): number {
  lastSequence += 1
  return lastSequence
}

export function workspaceSnapshotPruneKey(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): string {
  return `${executionHostId ?? '*'}\0${worktreeId}`
}

export function workspaceSnapshotPruneTargetKeys(
  targets: readonly WorkspaceSnapshotPruneTarget[]
): Set<string> {
  return new Set(
    targets.map(({ worktreeId, executionHostId }) =>
      workspaceSnapshotPruneKey(worktreeId, executionHostId)
    )
  )
}

/** Tombstones registered after this producer opened its fence — its result predates them. */
export function activeWorkspaceSnapshotPruneKeys(
  tombstones: ReadonlyMap<string, WorkspaceSnapshotPruneTombstone> | undefined,
  producerSeq: number
): Set<string> {
  const keys = new Set<string>()
  for (const [key, entry] of tombstones ?? []) {
    if (entry.prunedSeq > producerSeq) {
      keys.add(key)
    }
  }
  return keys
}

export function registerWorkspaceSnapshotPrunesForFile(
  tombstones: Map<string, WorkspaceSnapshotPruneTombstone>,
  targets: readonly WorkspaceSnapshotPruneTarget[],
  holders: Iterable<string>
): void {
  const prunedSeq = nextWorkspaceSnapshotPruneSequence()
  for (const { worktreeId, executionHostId } of targets) {
    const key = workspaceSnapshotPruneKey(worktreeId, executionHostId)
    // Union, never replace: a re-registered target may still be held by an earlier batch.
    const merged = new Set([...(tombstones.get(key)?.holders ?? []), ...holders])
    if (merged.size === 0) {
      // Nothing can resurrect this row, so there is nothing to remember. Retirement stays
      // single-sourced in the registry's release path instead of needing a sweeper.
      tombstones.delete(key)
      continue
    }
    tombstones.set(key, {
      worktreeId,
      ...(executionHostId ? { executionHostId } : {}),
      prunedSeq,
      holders: merged
    })
  }
}
