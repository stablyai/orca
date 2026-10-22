import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { isNativeLocalLocation } from '../../shared/execution-host'

/** Muse structured chats run beside the host, where `muse serve` spawns. */
export function supportsMuseStructuredLocation(location: AgentSessionExecutionLocation): boolean {
  return isNativeLocalLocation(location)
}
