import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { isRunningAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { endedJournalReasoning } from './journal-reasoning-row'

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

/** A message still open, ended by a sweep that cannot know when it stopped: no time is claimed. */
export function endedUnseenMessageBody(body: AgentJournalItemBody): AgentJournalMessageItem | null {
  if (body.kind !== 'message' || body.state !== 'running') {
    return null
  }
  const { completedAt: _unseen, ...open } = body
  return { ...open, ...endedJournalReasoning() }
}
