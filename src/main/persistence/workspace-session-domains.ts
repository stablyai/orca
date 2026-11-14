import { normalizeExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
/** Profile-state domains that hold saved workspace sessions (local and per host). */
export const WORKSPACE_SESSION_DOMAINS = ['workspaceSession', 'workspaceSessionsByHostId'] as const

export function sessionDomain(hostId?: string | null): string {
  return (normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
    ? WORKSPACE_SESSION_DOMAINS[0]
    : WORKSPACE_SESSION_DOMAINS[1]
}
