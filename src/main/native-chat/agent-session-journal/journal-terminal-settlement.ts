import {
  endedRunningAgentJournalToolCall,
  type AgentJournalRunningCallEnd
} from '../../../shared/agent-journal-tool-call-lifecycle'
import type {
  AgentJournalItemBody,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import {
  isRunningAgentJournalTurn,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import { cancelledJournalPromptBody } from './journal-prompt-body-bounds'

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

/** The row that settles an item no one will finish: a running tool call ends as `end` (how its
 *  turn or session ended) says, a pending prompt is cancelled. Null for an item that needs none.
 *  A null `end` ends no call: another writer settled the turn, and its calls stay the provider's.
 *  Turn rows are each writer's own to end. */
export function terminalAgentJournalBody(
  body: AgentJournalItemBody,
  end: AgentJournalRunningCallEnd | null
): AgentJournalItemBody | null {
  if (body.kind === 'tool-call') {
    return body.state === 'running' && end ? endedRunningAgentJournalToolCall(body, end) : null
  }
  if (body.kind === 'approval' || body.kind === 'question') {
    return body.resolution.state === 'pending' ? cancelledJournalPromptBody(body) : null
  }
  return null
}

/** How a call still running when its turn ends ends: as that turn's journal row ends. A row another
 *  writer settled first (a person's Stop) stands, so its calls take that row's state, not the
 *  settler's own verdict; a row still running, and work outside any turn, take the settler's `end`.
 *  Every settler that ends running calls asks this, so a call never disagrees with its turn. */
export function runningCallEnd(
  turnScope: AgentJournalTurnScope | undefined,
  itemBody: (itemId: string) => AgentJournalItemBody | null | undefined,
  end: AgentJournalRunningCallEnd
): AgentJournalRunningCallEnd {
  const row =
    turnScope?.kind === 'turn'
      ? readAgentJournalTurn(itemBody(turnScope.turnItemId) ?? undefined)
      : null
  return row && row.state !== 'running' ? row.state : end
}
