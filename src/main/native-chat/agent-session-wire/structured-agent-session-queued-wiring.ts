// Host wiring for mid-turn queueing: builds the serialized drain from the
// host's mutation context, with the /clear runner its /clear cards use, and exposes the draft
// actions (Send, Delete, Resume), so the host class stays a description of its surface.

import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { StructuredAgentSessionQueuedMessageDrain } from './structured-agent-session-queued-drain'
import {
  deleteQueuedStructuredAgentMessage,
  resumeStructuredAgentQueue,
  sendQueuedStructuredAgentMessage
} from './structured-agent-session-queued-mutations'
import { deferredStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  QUEUED_CLEAR_CALLER_KEY,
  runQueuedConversationClear
} from './structured-conversation-clear'

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
    wakeDelivery: (sessionId) => context().wakeDelivery(sessionId),
    // Read lazily, like the rest of this wiring: the host's deps are not assigned yet.
    logger: deferredStructuredAgentSessionLogger(() => context().deps.logger),
    readChildWork: (sessionId) => context().readChildWork(sessionId),
    backgroundTaskStops: (sessionId) => context().deps.adapter.backgroundTaskStops?.(sessionId),
    stoppedTaskEndingOwed: (sessionId) =>
      context().deps.adapter.stoppedTaskEndingOwed?.(sessionId) === true,
    runClear: (sessionId, card) => {
      const { store, adapter } = context().deps
      return runQueuedConversationClear(
        context(),
        {
          sessionId,
          journal: sessions.get(sessionId)!.journal,
          fence: structuredAgentSessionConversationFence(store, sessionId),
          adapter
        },
        card,
        agentSessionOperationKey(QUEUED_CLEAR_CALLER_KEY, card.messageId)
      )
    }
  })
  return {
    drain,
    /** Child work changed: the strip republishes, and a /clear card waiting on it may run. */
    onChildWorkChanged: (sessionId: string, strip: { publish: (sessionId: string) => void }) => {
      strip.publish(sessionId)
      drain.schedule(sessionId)
    },
    /** A /clear card waits on a handoff, which ends in the record store, not the journal. */
    wakeOnHandoffEnded: (store: Pick<AgentSessionRecordStore, 'onHandoffEnded'>) =>
      store.onHandoffEnded((sessionId) => drain.schedule(sessionId)),
    /** Every journal publish: turn, submission, prompt, command and Stop
     *  settlements are all commits, and each re-derives the drain's gates. */
    onJournalActivity: (sessionId: string) => {
      sessions.touch(sessionId)
      drain.schedule(sessionId)
    },
    queuedMessageSend: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof sendQueuedStructuredAgentMessage>[2]
    ) => sendQueuedStructuredAgentMessage(context(), caller, params),
    queuedMessageDelete: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof deleteQueuedStructuredAgentMessage>[2]
    ) => deleteQueuedStructuredAgentMessage(context(), caller, params),
    queuedMessagesResume: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof resumeStructuredAgentQueue>[2]
    ) => resumeStructuredAgentQueue(context(), caller, params)
  }
}
