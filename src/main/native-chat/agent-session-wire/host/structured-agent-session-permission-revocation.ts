import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'

/** At an admitted cut of this exact child: its queued permission-mode writes never reach it. */
export function revokeStructuredAgentSessionPermissionDispatch(
  adapter: Pick<StructuredAgentSessionAdapter, 'revokePermissionDispatch'>,
  sessionId: string,
  child: StructuredAgentSessionProviderChildIdentity | null | undefined
): void {
  if (child?.generation) {
    adapter.revokePermissionDispatch?.(sessionId, child.fence, child.generation)
  }
}
