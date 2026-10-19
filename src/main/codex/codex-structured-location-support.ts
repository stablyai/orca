import { isNativeLocalLocation } from '../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'

export function supportsCodexStructuredLocation(location: AgentSessionExecutionLocation): boolean {
  return isNativeLocalLocation(location)
}
