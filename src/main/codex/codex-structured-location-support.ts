import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'

export function supportsCodexStructuredLocation(
  location: AgentSessionExecutionLocation,
  // Injected by the adapter, which owns this dep for every other Codex gate too.
  hasWindowsProcessStartTimeProof: () => boolean = isWindowsProcessStartTimeAvailable
): boolean {
  return (
    location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    location.wslDistro === null &&
    (process.platform !== 'win32' || hasWindowsProcessStartTimeProof())
  )
}
