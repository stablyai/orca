// Save compares body fingerprints without changing card identity/order; edit leases block automatic delivery.

import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionQueuedMessageEditHoldParams,
  AgentSessionQueuedMessageEditHoldResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../shared/agent-session-wire'
import { queuedMessageEditableText } from '../../../shared/queued-message-edit'
import {
  queuedMessageUpdateDecision,
  type QueuedMessageUpdate
} from '../agent-session-journal/queued-message-update'
import { isAgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'
import { agentSessionAttachmentExpiredRefusal } from './structured-agent-session-turns'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { mutateQueued } from './structured-agent-session-queued-mutations'
import { queuedMessagesPublishedBytesRefusal } from './structured-agent-session-queued-published-bytes'

/** Editing sends nothing and needs no send admission; compare-and-set handles same-ID retries. */
export function updateQueuedStructuredAgentMessage(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: QueuedMessageUpdate & {
    envelope: AgentSessionMutationEnvelope
    /** Host-local queued-image capability. */
    queuedImageCards?: boolean
  }
): Promise<AgentSessionMutationResult<AgentSessionQueuedMessageUpdateResult>> {
  const { envelope, queuedImageCards, ...fields } = params
  const plan: MutationPlan<AgentSessionQueuedMessageUpdateResult> = {
    method: 'agentSession.queuedMessageUpdate',
    fields,
    conversationWrite: true,
    run: async (ctx) => {
      const queued = ctx.journal.queuedMessages
      const decision = queuedMessageUpdateDecision(
        queued.get(fields.messageId),
        ctx.sessionId,
        fields,
        queuedImageCards !== false
      )
      if (decision.status === 'unchanged') {
        return { ok: true, value: await queued.update(fields) }
      }
      if (decision.status !== 'ready') {
        return { ok: true, value: decision }
      }
      // Personal edits may use the user’s byte reserve, even for agent-origin cards.
      const refusal = queuedMessagesPublishedBytesRefusal(
        ctx.journal,
        decision.body,
        true,
        fields.messageId
      )
      if (refusal) {
        return { ok: false, refusal }
      }
      try {
        return { ok: true, value: await queued.update(fields) }
      } catch (error) {
        if (isAgentSessionAttachmentExpiredError(error)) {
          return agentSessionAttachmentExpiredRefusal()
        }
        throw error
      }
    },
    replay: () => null,
    rerunWhenReplayMissing: () => true
  }
  return mutateQueued(context, caller, envelope, plan)
}

/** Ephemeral edit lease, without ledger/startup; release never opens a closed conversation. */
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
      // Renewal adds no hold; avoid publication that would keep an unattended editor’s agent alive.
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

/** Publish/wake explicitly for nonjournaled leases; publication failure cannot revoke them. */
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
