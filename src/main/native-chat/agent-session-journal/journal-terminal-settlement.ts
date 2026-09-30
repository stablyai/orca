import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { isRunningAgentJournalTurn } from '../../../shared/agent-session-turn-record'

/** True while an item is still awaiting the row that settles it, so a sink can
 *  treat that row as lifecycle-critical rather than sheddable under pressure. */
export function requiresTerminalSettlement(body: AgentJournalItemBody): boolean {
  if (body.kind === 'tool-call') {
    return body.state === 'running'
  }
  if (body.kind === 'approval' || body.kind === 'question') {
    return body.resolution.state === 'pending'
  }
  return isRunningAgentJournalTurn(body)
}
