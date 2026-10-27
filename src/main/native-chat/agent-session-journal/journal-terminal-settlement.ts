import {
  endedRunningAgentJournalToolCall,
  type AgentJournalRunningCallEnd
} from '../../../shared/agent-journal-tool-call-lifecycle'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import {
  isRunningAgentJournalTurn,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import { cancelledJournalPromptBody } from './journal-prompt-body-bounds'
import { endedJournalReasoning } from './journal-reasoning-row'

/** Unsettled lifecycle rows must not be shed under pressure. */
export function requiresTerminalSettlement(body: AgentJournalItemBody): boolean {
  if (body.kind === 'tool-call') {
    return body.state === 'running'
  }
  if (body.kind === 'approval' || body.kind === 'question') {
    return body.resolution.state === 'pending'
  }
  return isRunningAgentJournalTurn(body)
}

/** Unknown end time must remain unstamped. */
export function endedUnseenMessageBody(body: AgentJournalItemBody): AgentJournalMessageItem | null {
  if (body.kind !== 'message' || body.state !== 'running') {
    return null
  }
  const { completedAt: _unseen, ...open } = body
  return { ...open, ...endedJournalReasoning() }
}

/** Settle abandoned calls/prompts; null end leaves calls to their provider, and turn rows to their writer. */
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

/** Calls inherit already-settled turn outcomes; otherwise use the settler's end. */
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
