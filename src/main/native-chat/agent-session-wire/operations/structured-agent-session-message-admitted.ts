import type { AgentSessionSendResult } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import { readContextStructuredAgentSessionTurn } from '../observations/structured-agent-session-read-work'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

/** Runs a send, then tells the host's listener of the message it handed over. */
export async function sendTellingAdmitted(
  deps: Pick<StructuredAgentSessionHostDeps, 'onMessageAdmitted'>,
  record: AgentSessionRecord | null,
  params: Parameters<typeof tellSentMessageAdmitted>[2],
  ctx: AgentSessionTurnContext,
  send: () => Promise<TurnOutcome<AgentSessionSendResult>>
): Promise<TurnOutcome<AgentSessionSendResult>> {
  const joining = (await readContextStructuredAgentSessionTurn(ctx)).activeTurnId !== null
  const sent = await send()
  if (sent.ok) {
    tellSentMessageAdmitted(deps, record, params, sent.value, joining)
  }
  return sent
}

/** Tells the host's listener of a message a send handed over. The drain tells a queued one when it
 *  hands it over; a recovery send brings no new message. */
function tellSentMessageAdmitted(
  deps: Pick<StructuredAgentSessionHostDeps, 'onMessageAdmitted'>,
  record: AgentSessionRecord | null,
  params: {
    body: AgentJournalMessageItem
    /** Restart recovery: resumes interrupted work, bringing no new message. */
    continuation?: true
    usageLimitContinuationOfTurnItemId?: string
  },
  sent: AgentSessionSendResult,
  joinsRunningTurn: boolean
): void {
  if (
    record &&
    !('queued' in sent) &&
    !params.continuation &&
    params.usageLimitContinuationOfTurnItemId === undefined
  ) {
    deps.onMessageAdmitted?.({
      sessionId: record.sessionId,
      workspaceId: record.location.workspaceId,
      clientMessageId: sent.clientMessageId,
      body: params.body,
      joinsRunningTurn
    })
  }
}
