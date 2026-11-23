import { agentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { agentBackgroundWait } from '../../../../../shared/agent-status/lifecycle/agent-background-wait'
import { chatPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'

type StatusRows = {
  getStatusSnapshotForPane: (paneKey: string) => readonly AgentStatusIpcPayload[]
}

/** A chat whose turn its own background tasks hold open, by its status row. */
export function chatWaitsOnBackground(rows: StatusRows, sessionId: string): boolean {
  return rows
    .getStatusSnapshotForPane(chatPaneKey(sessionId))
    .some((row) => agentBackgroundWait(row) !== null)
}

/** A terminal pane with no row yet (not restored) proves nothing, but a chat lives in this process:
 *  with no row its tasks are gone. A row that names another turn ends the wait. */
export function rowsShowWait(
  rows: readonly AgentStatusIpcPayload[],
  wait: { since: number; chat?: true }
): boolean {
  return rows.length === 0
    ? !wait.chat
    : rows.some((row) => agentBackgroundWait(row)?.since === wait.since)
}

/** Whether a recorded wait's pane still shows it, by this host's status rows. */
export function backgroundWaitShown(
  rows: StatusRows,
  wait: { since: number; paneKey?: string; chat?: true }
): boolean {
  return !wait.paneKey || rowsShowWait(rows.getStatusSnapshotForPane(wait.paneKey), wait)
}

/** The report deps that read background waits from this host's status rows. */
export function backgroundWaitReportDeps(
  rows: StatusRows = agentHookServer
): Pick<WorkerTurnStopReportDeps, 'chatWaitsOnBackground' | 'backgroundWaitShown'> {
  return {
    chatWaitsOnBackground: (sessionId) => chatWaitsOnBackground(rows, sessionId),
    backgroundWaitShown: (wait) => backgroundWaitShown(rows, wait)
  }
}
