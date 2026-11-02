// Editing a queued card in place: Save is a compare-and-set on the card's body fingerprint, and
// an edit lease keeps automatic delivery from sending the card while someone types. The card keeps
// its id, position, sender and attachments; only its text changes.

import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionQueuedMessageEditHoldParams,
  AgentSessionQueuedMessageEditHoldResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../shared/agent-session-wire'
import { queuedMessageEditableText } from '../../../shared/queued-message-text-edit'
import { queuedMessageTextUpdateDecision } from '../agent-session-journal/queued-message-text-update'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { mutateQueued } from './structured-agent-session-queued-mutations'
import { queuedMessagesPublishedBytesRefusal } from './structured-agent-session-queued-published-bytes'

/** Save. Editing sends nothing, so it pays no send admission, like Delete. A resend under the
 *  same id simply runs again: the compare-and-set answers it from the card as it stands. */
export function updateQueuedStructuredAgentMessage(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    messageId: string
    expectedBodyFingerprint: string
    text: string
  }
): Promise<AgentSessionMutationResult<AgentSessionQueuedMessageUpdateResult>> {
  const { envelope, ...fields } = params
  const plan: MutationPlan<AgentSessionQueuedMessageUpdateResult> = {
    method: 'agentSession.queuedMessageUpdate',
    fields,
    conversationWrite: true,
    run: async (ctx) => {
      const queued = ctx.journal.queuedMessages
      const decision = queuedMessageTextUpdateDecision(
        queued.get(fields.messageId),
        ctx.sessionId,
        fields
      )
      if (decision.status !== 'ready') {
        return { ok: true, value: decision }
      }
      // Editing an agent's card is still the person's action, so it may use their reserve.
      const refusal = queuedMessagesPublishedBytesRefusal(
        ctx.journal,
        decision.body,
        true,
        fields.messageId
      )
      return refusal ? { ok: false, refusal } : { ok: true, value: await queued.update(fields) }
    },
    replay: () => null,
    rerunWhenReplayMissing: () => true
  }
  return mutateQueued(context, caller, envelope, plan)
}

/** Acquire, renew and release an edit lease. Ephemeral: no ledger row, no agent started, and a
 *  release never opens a conversation (a closed one already dropped its leases). */
export function holdQueuedStructuredAgentMessageEdit(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionQueuedMessageEditHoldParams
): Promise<AgentSessionQueuedMessageEditHoldResult> {
  const { sessionId, messageId } = params
  const key = { callerKey: caller.callerKey, editId: params.editId }
  return context.serialize(sessionId, async () => {
    if (params.action === 'release') {
      const journal = context.sessions.get(sessionId)?.journal
      journal?.queuedMessages.editLeases.release(key, messageId)
      if (journal) {
        republish(context, sessionId, journal)
      }
      return { status: 'released' }
    }
    const session = await context.openConversation(sessionId)
    if (!session) {
      return { status: 'gone' }
    }
    const queued = session.journal.queuedMessages
    if (params.action !== 'acquire') {
      // Holds nothing new, so nothing to publish (a lapsed lease it prunes wakes the queue itself);
      // and a publish is idle-sweep activity, which an editor left open must not renew forever.
      return queued.editLeases.renew(key, messageId)
    }
    const row = queued.get(messageId)
    const result: AgentSessionQueuedMessageEditHoldResult =
      row && queuedMessageEditableText(row.body) === null
        ? { status: 'not-editable' }
        : queued.editLeases.acquire(key, { messageId, fingerprint: params.expectedBodyFingerprint })
    republish(context, sessionId, session.journal)
    return result
  })
}

/** Leases live outside the journal, so no commit announces them: publish the next card to send
 *  and wake the drain here. A failed publish is logged; the lease still stands. */
export function republish(
  context: StructuredAgentSessionMutationContext,
  sessionId: string,
  journal: Parameters<StructuredAgentSessionMutationContext['publish']>[1]
): void {
  try {
    context.publish(sessionId, journal)
  } catch (error) {
    context.deps.logger.warn('publishing a queued edit hold failed', {
      scope: 'queued-edit-hold',
      sessionId,
      error
    })
  }
  context.wakeQueuedDrain?.(sessionId)
}
