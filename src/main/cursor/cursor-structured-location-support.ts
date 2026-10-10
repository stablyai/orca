import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'

export function cursorSdkHomePath(): string {
  return join(homedir(), '.cursor', 'sdk')
}

/** Same host gate as Claude and Codex structured chat: the runtime is this execution host. */
export function supportsCursorStructuredLocation(location: AgentSessionExecutionLocation): boolean {
  return (
    location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    location.wslDistro === null &&
    (process.platform !== 'win32' || isWindowsProcessStartTimeAvailable())
  )
}
