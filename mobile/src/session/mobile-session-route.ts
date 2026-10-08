import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'

export type MobileSessionRouteParams = {
  hostId: string
  worktreeId: string
  paneKey?: string
  name?: string
  /** The server a `runtime:` workspace runs on; absent for the desktop's own workspaces. */
  executionHost?: ExecutionHostId
}

/** Identities stay raw — the navigator owns the params, so pre-encoding a
 *  workspace id would reach the session screen still escaped. */
export function mobileSessionRouteTarget({
  hostId,
  worktreeId,
  name,
  paneKey,
  executionHost
}: MobileSessionRouteParams): HostStackRouteTarget {
  return {
    name: '[hostId]/session/[worktreeId]',
    params: {
      hostId,
      worktreeId,
      ...(name ? { name } : {}),
      ...(paneKey ? { paneKey } : {}),
      ...(executionHost ? { executionHost } : {})
    }
  }
}
