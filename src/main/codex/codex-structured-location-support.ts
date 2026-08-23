import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'

export function supportsCodexStructuredLocation(location: AgentSessionExecutionLocation): boolean {
  return location.executionHostId === LOCAL_EXECUTION_HOST_ID && location.wslDistro === null
}
