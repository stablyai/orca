import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'

type WorkspaceSessionPartitions = Partial<Record<ExecutionHostId, WorkspaceSessionState>>

/** One new map with every partition `migrate` replaced, or the same map when none changed. */
export function replaceWorkspaceSessionPartitions(
  partitions: WorkspaceSessionPartitions | undefined,
  migrate: (session: WorkspaceSessionState) => WorkspaceSessionState | null
): WorkspaceSessionPartitions | undefined {
  let next: Record<string, WorkspaceSessionState | undefined> | undefined
  for (const [hostId, session] of Object.entries(partitions ?? {})) {
    const migrated = session && migrate(session)
    if (migrated) {
      next ??= { ...partitions }
      next[hostId] = migrated
    }
  }
  return next ?? partitions
}
