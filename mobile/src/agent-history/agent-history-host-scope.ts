import { parseExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import type { Worktree } from '../worktree/workspace-list-types'
import { MOBILE_AI_VAULT_HOST_SCOPE_CAPABILITY } from './agent-history-capability'

/**
 * The host scope to request for the active workspace, mirroring desktop where an SSH workspace
 * defaults to its own remote host. Undefined keeps the serving host's local scan, which is also
 * what a host that does not advertise the capability must receive (it would drop the field).
 */
export function resolveMobileAgentHistoryHostScope(
  activeWorktree: Pick<Worktree, 'hostId'> | null,
  hostCapabilities: readonly string[] | undefined
): Extract<ExecutionHostId, `ssh:${string}`> | undefined {
  if (!hostCapabilities?.includes(MOBILE_AI_VAULT_HOST_SCOPE_CAPABILITY)) {
    return undefined
  }
  const parsed = parseExecutionHostId(activeWorktree?.hostId)
  return parsed?.kind === 'ssh' ? parsed.id : undefined
}
