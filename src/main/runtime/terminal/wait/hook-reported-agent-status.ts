import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentStatus } from '../../../../shared/agent-status/title/agent-title-core'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { hookLeadTurnState } from './tui-idle-hook-lane'

/** The status the pane agent's latest live hook report gives, for a pane whose title names none.
 *  Null when no report speaks for the agent now running, or at a session start, which is no turn end
 *  (the composer may not take input yet). */
export function hookReportedAgentStatus(read: {
  row: AgentStatusIpcPayload | null
  readEnded: (paneKey: string) => boolean
  agent: TerminalAgent | null
  respawnedAt: number | undefined
  /** A title seen after the report (a shell retitling its prompt) means the agent left. */
  titleObservedAt: number | null
  isCurrentReport: (reportedAt: number) => boolean
}): AgentStatus | null {
  const { row } = read
  // A replayed report is restamped on receipt; its evidence time is when the agent said it.
  const reportedAt = row ? (row.evidenceObservedAt ?? row.receivedAt) : 0
  // An ended agent's last report, one from an earlier program in the pane, or one from before a
  // respawn or reattach speaks for no one now.
  if (
    !row ||
    read.readEnded(row.paneKey) ||
    (read.agent !== null && row.agentType !== read.agent) ||
    reportedAt < (read.respawnedAt ?? -1) ||
    reportedAt < (read.titleObservedAt ?? -1) ||
    !read.isCurrentReport(reportedAt)
  ) {
    return null
  }
  const turn = hookLeadTurnState(row)
  return turn === null ? null : turn === 'done' ? 'idle' : turn
}
