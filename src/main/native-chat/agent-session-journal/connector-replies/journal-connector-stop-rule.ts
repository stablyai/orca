// The rule for a send a person's Stop or close took back: it reads as stopped, never as failed.
// Pure, so the connector can apply it to a live rejection without the journal's writer helpers.
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureKind
} from '../../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalStopEvent } from '../durable-rows/journal-row-schema'
import { stopIsAPersons } from '../context-epochs/journal-stop-turn-end'

// Kinds a Stop or close rejects unsent sends with. Orca's own stops use them too, so only a
// person's saved Stop between the send and its rejection makes one read as stopped.
const STOP_REJECTIONS: ReadonlySet<AgentSessionFailureKind> = new Set(['cancelled', 'chatClosed'])

export type RejectedSend = Pick<
  AgentJournalSubmission,
  'rejection' | 'submittedAt' | 'resolvedAt' | 'keptAsQueuedMessageId'
>
export type SavedStop = Pick<JournalStopEvent, 'reason' | 'at'> | null

/** Whether a rejection could be a Stop's, so the saved Stop is worth reading. */
export function stopMayHaveRejected(send: Pick<RejectedSend, 'rejection'>): boolean {
  const fact = readAgentSessionFailureFact(send.rejection)
  return fact !== undefined && STOP_REJECTIONS.has(fact.kind)
}

/** A send a person's Stop or close took back before the agent ran it. One kept as a waiting card
 *  (a close's hold) still runs later, so its conversation keeps waiting for the answer. */
export function personStopTookBack(send: RejectedSend, stop: SavedStop): boolean {
  return (
    send.keptAsQueuedMessageId === undefined &&
    stopMayHaveRejected(send) &&
    stop !== null &&
    stopIsAPersons(stop.reason) &&
    stop.at >= send.submittedAt &&
    (send.resolvedAt === null || stop.at <= send.resolvedAt)
  )
}
