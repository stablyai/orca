import {
  borrowWorkspaceSession,
  isOwnedWorkspaceSession
} from '../../../persistence/loading-store/workspace-sessions/session-host-partitions'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** The pane's saved resume on this host, which its window resumes from after a cold restore. */
export function savedResumeRecord(
  store:
    | { getWorkspaceSession?(hostId: ExecutionHostId): WorkspaceSessionState | undefined }
    | undefined,
  paneKey: string | null
): SleepingAgentSessionRecord | undefined {
  const record = paneKey
    ? borrowWorkspaceSession(store, LOCAL_EXECUTION_HOST_ID)?.sleepingAgentSessionsByPaneKey?.[
        paneKey
      ]
    : undefined
  return record && isOwnedWorkspaceSession(store, LOCAL_EXECUTION_HOST_ID)
    ? structuredClone(record)
    : record
}
