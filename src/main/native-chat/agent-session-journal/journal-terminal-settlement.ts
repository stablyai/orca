import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { isRunningAgentJournalTurn } from '../../../shared/agent-session-turn-record'
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

/** The row that settles an item no one will finish: a running tool call fails, a pending prompt
 *  is cancelled. Null for an item that needs none. Turn rows are each writer's own to end. */
export function terminalAgentJournalBody(body: AgentJournalItemBody): AgentJournalItemBody | null {
  if (body.kind === 'tool-call') {
    return body.state === 'running' ? { ...body, state: 'failed' } : null
  }
  if (body.kind === 'approval' || body.kind === 'question') {
    return body.resolution.state === 'pending' ? cancelledJournalPromptBody(body) : null
  }
  return null
}
