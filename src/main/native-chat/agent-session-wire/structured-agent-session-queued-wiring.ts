// Host wiring for mid-turn queueing: builds the serialized drain from the
// host's mutation context and exposes the draft actions (Send, Delete, Resume), so the host
// class stays a description of its surface.

import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { StructuredAgentSessionQueuedMessageDrain } from './structured-agent-session-queued-messages'
import {
  deleteQueuedStructuredAgentMessage,
  resumeStructuredAgentQueue,
  sendQueuedStructuredAgentMessage
} from './structured-agent-session-queued-mutations'
import { deferredStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { structuredAgentSessionEndedChildHoldsLease } from './structured-agent-session-child-close'

/** `sessions` are the live conversations (their `touch` is the idle sweep's activity renewal,
 *  which the drain's schedule rides); everything else comes from the host's mutation context,
 *  read lazily because the host's fields are still initializing when this is built. */
export function wireStructuredAgentSessionQueuedMessages(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession> & {
    touch: (sessionId: string) => void
  },
  context: () => StructuredAgentSessionMutationContext
) {
  const drain = new StructuredAgentSessionQueuedMessageDrain({
    sessions,
    getRecord: (sessionId) => context().deps.store.getRecord(sessionId),
    serialize: (sessionId, task) => context().serialize(sessionId, task),
    conversationFence: (sessionId) =>
      structuredAgentSessionConversationFence(context().deps.store, sessionId),
    currentWork: (sessionId) =>
      hostStructuredAgentSessionCurrentWork({ store: context().deps.store, sessions }, sessionId),
    wakeDelivery: (sessionId) => context().wakeDelivery(sessionId),
    releaseOwed: (sessionId) =>
      structuredAgentSessionEndedChildHoldsLease({ deps: context().deps, sessions }, sessionId) &&
      context().reconciliationOwes(sessionId),
    publish: (sessionId, journal) => context().publish(sessionId, journal),
    // Read lazily, like the rest of this wiring: the host's deps are not assigned yet.
    logger: deferredStructuredAgentSessionLogger(() => context().deps.logger)
  })
  return {
    drain,
    /** Every journal publish: turn, submission, prompt, command and Stop
     *  settlements are all commits, and each re-derives the drain's gates. */
    /** `activity`: false for a generation's end, which wakes the drain but is no activity. */
    onJournalActivity: (sessionId: string, activity = true) => {
      if (activity) {
        sessions.touch(sessionId)
      }
      drain.schedule(sessionId)
    },
    queuedMessageSend: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof sendQueuedStructuredAgentMessage>[2]
    ) => {
      // A person's Send now moves the card on: a send the drain was retrying starts fresh.
      drain.cardMoved(params.envelope.sessionId)
      return sendQueuedStructuredAgentMessage(context(), caller, params)
    },
    queuedMessageDelete: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof deleteQueuedStructuredAgentMessage>[2]
    ) => {
      drain.cardMoved(params.envelope.sessionId)
      return deleteQueuedStructuredAgentMessage(context(), caller, params)
    },
    queuedMessagesResume: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof resumeStructuredAgentQueue>[2]
    ) => resumeStructuredAgentQueue(context(), caller, params)
  }
}
