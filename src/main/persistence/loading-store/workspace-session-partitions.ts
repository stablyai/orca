import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceSessionSalvaging } from '../../../shared/workspace-session-salvage'
import { withoutRedundantGlobalFields } from '../../../shared/workspace-session-host-field-ownership'

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

/** Validate hosts independently; local stays in legacy workspaceSession to prevent duplicate authority. */
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
    // Reject local/invalid aliases so they cannot shadow the canonical local partition.
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
    // Drop redundant fields before defaults restore required map entries.
    partitions[hostId] = {
      ...defaults,
      ...withoutRedundantGlobalFields(result.value, localSession)
    }
  }
  return { partitions, repaired }
}
