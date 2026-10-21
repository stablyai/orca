import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'

/** Where an agent child this runtime spawns and supervises itself can run: on this machine, outside
 *  WSL, and on Windows only where a process start time proves which process a record names. */
export function supportsSupervisedProviderChildLocation(
  location: AgentSessionExecutionLocation,
  hasWindowsProcessStartTimeProof: () => boolean = isWindowsProcessStartTimeAvailable
): boolean {
  return (
    location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    location.wslDistro === null &&
    (process.platform !== 'win32' || hasWindowsProcessStartTimeProof())
  )
}
