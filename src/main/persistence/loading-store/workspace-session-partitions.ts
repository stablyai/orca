import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceSessionSalvaging } from '../../../shared/workspace-session-salvage'

export function workspaceSessionSalvageLogDetails(result: {
  droppedCount: number
  droppedPaths: string[]
}): { count: number; fields: string[]; detailsTruncated: boolean } {
  return {
    count: result.droppedCount,
    fields: [...new Set(result.droppedPaths.map((path) => path.split('.', 1)[0]))],
    detailsTruncated: result.droppedCount > result.droppedPaths.length
  }
}

/**
 * Global fields belong to the 'local' slice: the split writes them only there and the merge reads
 * them only from there. A copy inside a non-local partition is legacy residue no read can reach —
 * stale `browserUrlHistory` replicas alone were 589 KB, 12.7% of a 4.65 MB store, rewritten on
 * every save and reparsed on every launch.
 *
 * Deliberately NOT every field in `GLOBAL_WORKSPACE_SESSION_FIELDS`. Two separate gates disqualify
 * the rest, and both are load-bearing:
 *  - `activeWorktreeId` and `activeWorkspaceKey` are `'direct'` in
 *    `WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND`, and both `collectPersistedSessionWorktreeOwners`
 *    and the deregistered-repo residue sweep read them out of EVERY partition. Dropping one
 *    un-owns a worktree, and an un-owned worktree gets its metadata pruned.
 *  - `activeTabId`, `activeConnectionIdsAtShutdown` and `activeRepoId` have live main-side readers
 *    on a partition: `isPersistedTerminalLeafActive` falls back to `activeTabId` for the mobile
 *    projection, and the runtime attach-window handoff unions `activeConnectionIdsAtShutdown`.
 *
 * `workspace-session-partitions.test.ts` re-checks both gates for every field listed here.
 */
export const HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS = [
  'browserUrlHistory',
  'workspaceDocHistory'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

/** Dropped only where local already holds the field — exactly when the merge's fallback to another
 *  slice cannot fire. Runs before the defaults spread, so a field the type requires comes back at
 *  its default rather than going missing. */
function dropRedundantGlobalFields(
  slice: Partial<WorkspaceSessionState>,
  local: WorkspaceSessionState | undefined
): void {
  for (const field of HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS) {
    if (local?.[field] !== undefined) {
      delete slice[field]
    }
  }
}

/** Normalize non-'local' host partitions; 'local' (the legacy workspaceSession blob) is dropped so the two surfaces never diverge.
 *  Each partition is zod-validated independently, so one corrupt host drops to defaults without taking out the others. Idempotent. */
export function parseWorkspaceSessionsByHostId(
  raw: unknown,
  defaults: WorkspaceSessionState,
  localSession?: WorkspaceSessionState
): { partitions: Partial<Record<ExecutionHostId, WorkspaceSessionState>>; repaired: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { partitions: {}, repaired: raw !== undefined }
  }
  let repaired = false
  const partitions: Partial<Record<ExecutionHostId, WorkspaceSessionState>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const hostId = normalizeExecutionHostId(key)
    // Why: 'local' lives in workspaceSession; a local/invalid key here is legacy noise that must not shadow the canonical partition.
    if (!hostId || hostId === LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const result = parseWorkspaceSessionSalvaging(value)
    if (!result.ok) {
      repaired = true
      console.error(
        `[persistence] Corrupt workspace session for host ${hostId}, using defaults:`,
        result.error
      )
      continue
    }
    if (result.droppedCount > 0) {
      console.warn(
        `[persistence] Salvaged workspace session for host ${hostId}; dropped corrupt entries:`,
        workspaceSessionSalvageLogDetails(result)
      )
      repaired = true
    }
    dropRedundantGlobalFields(result.value, localSession)
    partitions[hostId] = { ...defaults, ...result.value }
  }
  return { partitions, repaired }
}
