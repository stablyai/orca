import { isDormantRecoveryRecord } from '../../shared/agent-session-resume'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** A dormant recovered session's pane waits for Resume or "Start shell instead"; no tap mints its PTY. */
export function isDormantRecoveryPane(
  session: Pick<WorkspaceSessionState, 'sleepingAgentSessionsByPaneKey'> | null | undefined,
  tab: { parentTabId: string; leafId: string }
): boolean {
  const record = session?.sleepingAgentSessionsByPaneKey?.[makePaneKey(tab.parentTabId, tab.leafId)]
  return record !== undefined && isDormantRecoveryRecord(record)
}
