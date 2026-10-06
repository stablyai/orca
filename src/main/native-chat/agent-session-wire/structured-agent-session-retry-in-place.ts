// The person's Retry of a message no agent ever took: the same message is queued again under its
// own id, so the chat never holds two copies of it and a second press, from any device, sends
// nothing more. Its own operation id keeps `agentSession.send`'s rule (one id, one delivery) whole.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { isRequeueableAgentJournalSubmission } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  mutateStructuredAgentSession,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-mutation-context'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { openForWrite } from './structured-agent-session-send-preparation'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

/** The message as it stands after the Retry: queued again, or already past rejected. */
export type AgentSessionRetryMessageResult = {
  clientMessageId: string
  submission: AgentJournalSubmission
}

export function retryStructuredAgentSessionMessage(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; clientMessageId: string }
): Promise<AgentSessionMutationResult<AgentSessionRetryMessageResult>> {
  const { clientMessageId } = params
  const current = (ctx: AgentSessionTurnContext) => {
    const submission = ctx.journal
      .submissions()
      .find((entry) => entry.clientMessageId === clientMessageId)
    // A rewind can take the message out of the chat; there is nothing left to send again.
    return submission && ctx.journal.itemBody(agentJournalSubmissionKey(clientMessageId))
      ? submission
      : undefined
  }
  const plan: MutationPlan<AgentSessionRetryMessageResult> = {
    method: 'agentSession.retryMessage',
    fields: { clientMessageId },
    conversationWrite: true,
    run: async (ctx) => {
      const submission = current(ctx)
      if (!submission) {
        return {
          ok: false,
          refusal: refuse(
            'agent_session_operation_invalid',
            { reason: 'requestMalformed' },
            'That message is no longer in this chat.'
          )
        }
      }
      // Anything else — queued again by another press, delivered, or never retryable — answers
      // as it stands: a Retry never sends a message twice.
      if (isRequeueableAgentJournalSubmission(submission)) {
        // The commit wakes the delivery loop, which hands it over as the oldest queued message.
        await ctx.journal.resolveDispatch({
          clientMessageId,
          fence: ctx.fence,
          state: 'pending',
          requeued: true
        })
      }
      return { ok: true, value: { clientMessageId, submission: current(ctx) ?? submission } }
    },
    replay: (ctx) => {
      const submission = current(ctx)
      return submission ? { clientMessageId, submission } : null
    }
  }
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    plan,
    openForWrite(context, params.envelope)
  )
}
