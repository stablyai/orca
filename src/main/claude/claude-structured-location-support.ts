import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'

export function supportsClaudeStructuredLocation(location: AgentSessionExecutionLocation): boolean {
  return (
    location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    location.wslDistro === null &&
    (process.platform !== 'win32' || isWindowsProcessStartTimeAvailable())
  )
}
