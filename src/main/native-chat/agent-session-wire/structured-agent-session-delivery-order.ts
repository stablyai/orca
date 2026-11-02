import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'

export type StructuredAgentSessionDeliveryPlace = {
  before: Promise<void>
  release: () => void
}

type Lane = {
  tail: Promise<void>
  places: Set<StructuredAgentSessionDeliveryPlace>
  sends: Map<string, StructuredAgentSessionDeliveryPlace>
}

/** One delivery order; journal commits retire sends, bounded callers retire operations. */
export class StructuredAgentSessionDeliveryOrder {
  private readonly lanes = new Map<string, Lane>()

  reconcile(sessionId: string, submissions: readonly AgentJournalSubmission[]): void {
    const queued = submissions.filter(isQueuedAgentJournalSubmission)
    const lane = this.lanes.get(sessionId)
    const ids = new Set(queued.map((submission) => submission.clientMessageId))
    for (const [id, place] of lane?.sends ?? []) {
      if (!ids.has(id)) {
        lane?.sends.delete(id)
        place.release()
      }
    }
    for (const submission of queued.sort(
      (a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0)
    )) {
      const current = this.lanes.get(sessionId)
      if (!current?.sends.has(submission.clientMessageId)) {
        const place = this.reserve(sessionId)
        this.lanes.get(sessionId)?.sends.set(submission.clientMessageId, place)
      }
    }
  }

  reserve(sessionId: string): StructuredAgentSessionDeliveryPlace {
    const lane = this.lanes.get(sessionId) ?? {
      tail: Promise.resolve(),
      places: new Set(),
      sends: new Map()
    }
    this.lanes.set(sessionId, lane)
    const done = Promise.withResolvers<void>()
    const place: StructuredAgentSessionDeliveryPlace = {
      before: lane.tail,
      release: () => {
        done.resolve()
        lane.places.delete(place)
        if (lane.places.size === 0 && this.lanes.get(sessionId) === lane) {
          this.lanes.delete(sessionId)
        }
      }
    }
    lane.places.add(place)
    lane.tail = Promise.all([place.before, done.promise]).then(() => undefined)
    return place
  }

  beforeSend(sessionId: string, messageId: string): Promise<void> {
    return this.lanes.get(sessionId)?.sends.get(messageId)?.before ?? Promise.resolve()
  }

  /** Queued messages keep their journal rows, but stop ordering operations when delivery parks. */
  parkSends(sessionId: string): void {
    const lane = this.lanes.get(sessionId)
    for (const place of lane?.sends.values() ?? []) {
      place.release()
    }
    lane?.sends.clear()
  }

  dispose(): void {
    for (const lane of this.lanes.values()) {
      for (const place of lane.places) {
        place.release()
      }
    }
    this.lanes.clear()
  }
}
