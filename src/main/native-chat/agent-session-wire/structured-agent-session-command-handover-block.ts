// Whether a conversation command may run at its handover: run, or refused with why.

import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import {
  STRUCTURED_AGENT_SESSION_COMPACT_COMMAND,
  type StructuredAgentSessionCommandHandoverContext
} from './structured-agent-session-command-turn'
import { conversationCommandBlocked } from './structured-conversation-command-admission'

/** Why the command may not run now, as the fact its message is rejected with; null when it may. */
export function commandBlocked(
  ctx: StructuredAgentSessionCommandHandoverContext,
  body: AgentJournalMessageItem
): SubmissionRejectionFact | null {
  if (body.command?.name !== STRUCTURED_AGENT_SESSION_COMPACT_COMMAND || !ctx.adapter.compact) {
    return agentSessionFailureFact('commandRefused')
  }
  const record = ctx.record()
  if (!record) {
    return agentSessionFailureFact('hostFault')
  }
  const refusal = conversationCommandBlocked(ctx, record, ctx.childWork(), 'handover')
  return refusal
    ? agentSessionFailureFact('commandRefused', { refusal: agentSessionRefusalReference(refusal) })
    : null
}
