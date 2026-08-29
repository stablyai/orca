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

/** Normalize non-'local' host partitions; 'local' (the legacy workspaceSession blob) is dropped so the two surfaces never diverge.
 *  Each partition is zod-validated independently, so one corrupt host drops to defaults without taking out the others. Idempotent. */
export function parseWorkspaceSessionsByHostId(
  raw: unknown,
  defaults: WorkspaceSessionState
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
    partitions[hostId] = { ...defaults, ...result.value }
  }
  return { partitions, repaired }
}
