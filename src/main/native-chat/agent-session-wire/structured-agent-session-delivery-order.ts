import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { selectedStructuredSubmission } from './structured-agent-session-input-selection'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'

export type StructuredAgentSessionDeliveryPlace = {
  before: Promise<void>
  release: () => void
}

type OptionsCycle = StructuredAgentSessionDeliveryPlace & {
  child: StructuredAgentSessionProviderChild
  signal: AbortSignal
  ready: Promise<void>
  demand: 'refresh' | 'idle' | 'sealed'
}

type Lane = {
  tail: Promise<void>
  places: Set<StructuredAgentSessionDeliveryPlace>
  sends: Map<string, StructuredAgentSessionDeliveryPlace>
  active: Set<string>
  options?: OptionsCycle
}

/** One delivery order; active handovers retain their place through settlement. */
export class StructuredAgentSessionDeliveryOrder {
  private readonly lanes = new Map<string, Lane>()

  reconcile(sessionId: string, journal: AgentSessionJournal | undefined): void {
    const selected = journal && selectedStructuredSubmission(journal)
    const queued = selected ? [selected] : []
    const lane = this.lanes.get(sessionId)
    if (lane?.options && (queued.length > 0 || lane.active.size > 0)) {
      lane.options.demand = 'sealed'
    }
    const ids = new Set(queued.map((submission) => submission.clientMessageId))
    for (const [id, place] of lane?.sends ?? []) {
      if (!ids.has(id) && !lane?.active.has(id)) {
        lane?.sends.delete(id)
        place.release()
      }
    }
    for (const submission of queued) {
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
      sends: new Map(),
      active: new Set()
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

  joinOptions(sessionId: string, child: StructuredAgentSessionProviderChild): boolean {
    const cycle = this.lanes.get(sessionId)?.options
    if (!cycle || cycle.child !== child || cycle.signal.aborted) {
      return false
    }
    if (cycle.demand !== 'sealed') {
      cycle.demand = 'refresh'
    }
    return true
  }

  /** One optional producer shares the send order and the prepared readers' completion. */
  reserveOptions(
    sessionId: string,
    child: StructuredAgentSessionProviderChild,
    signal: AbortSignal
  ): OptionsCycle {
    const place = this.reserve(sessionId)
    const lane = this.lanes.get(sessionId)!
    const cycle: OptionsCycle = {
      child,
      signal,
      before: place.before,
      ready: lane.tail,
      demand: 'refresh',
      release: () => {
        if (lane.options === cycle) {
          lane.options = undefined
        }
        place.release()
      }
    }
    lane.options = cycle
    return cycle
  }

  optionsReady(sessionId: string): Promise<void> | undefined {
    return this.lanes.get(sessionId)?.options?.ready
  }

  beforeSend(sessionId: string, messageId: string): Promise<void> {
    return this.lanes.get(sessionId)?.sends.get(messageId)?.before ?? Promise.resolve()
  }

  activateSend(sessionId: string, messageId: string): () => void {
    const lane = this.lanes.get(sessionId)
    const place = lane?.sends.get(messageId)
    lane?.active.add(messageId)
    return () => {
      lane?.active.delete(messageId)
      lane?.sends.delete(messageId)
      place?.release()
    }
  }

  hasActiveSend(sessionId: string): boolean {
    return (this.lanes.get(sessionId)?.active.size ?? 0) > 0
  }

  /** Queued messages keep their journal rows, but stop ordering operations when delivery parks. */
  parkSends(sessionId: string): void {
    const lane = this.lanes.get(sessionId)
    for (const [id, place] of lane?.sends ?? []) {
      if (!lane?.active.has(id)) {
        lane?.sends.delete(id)
        place.release()
      }
    }
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
