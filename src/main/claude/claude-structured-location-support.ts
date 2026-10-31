import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { isNativeLocalLocation } from '../../shared/execution-host'

export function supportsClaudeStructuredLocation(location: AgentSessionExecutionLocation): boolean {
  return isNativeLocalLocation(location)
}
