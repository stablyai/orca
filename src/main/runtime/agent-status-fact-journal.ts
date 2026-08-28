import { randomUUID } from 'node:crypto'
import type { AgentStatusFact, AgentStatusFactInput } from '../../shared/agent-status-fact-types'

export type AgentStatusFactJournalRead = {
  epoch: string
  headSeq: number
  gap: boolean
  facts: AgentStatusFact[]
}

const DEFAULT_CAPACITY = 512

/** Host-owned ordered facts used by paired clients while their tab inventory is parked. */
export class AgentStatusFactJournal {
  private readonly capacity: number
  private readonly epochId = randomUUID()
  private nextSeq = 0
  private readonly facts: AgentStatusFact[] = []
  private readonly listeners = new Set<(fact: AgentStatusFact) => void>()

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  get epoch(): string {
    return this.epochId
  }

  get headSeq(): number {
    return this.nextSeq
  }

  record(input: AgentStatusFactInput): AgentStatusFact {
    const fact: AgentStatusFact = {
      ...input,
      seq: ++this.nextSeq,
      epoch: this.epochId
    }
    this.facts.push(fact)
    if (this.facts.length > this.capacity) {
      this.facts.splice(0, this.facts.length - this.capacity)
    }
    for (const listener of this.listeners) {
      try {
        listener(fact)
      } catch (error) {
        // A stale stream must not abort hook ingestion or starve other clients.
        console.warn('[agent-status-facts] listener failed:', error)
      }
    }
    return fact
  }

  readSince(lastSeenSeq?: number, epoch?: string): AgentStatusFactJournalRead {
    if (lastSeenSeq === undefined || epoch === undefined) {
      return { epoch: this.epochId, headSeq: this.nextSeq, gap: false, facts: [] }
    }
    if (epoch !== this.epochId) {
      return { epoch: this.epochId, headSeq: this.nextSeq, gap: true, facts: [] }
    }
    const oldestSeq = this.facts[0]?.seq ?? this.nextSeq + 1
    if (lastSeenSeq < oldestSeq - 1) {
      return { epoch: this.epochId, headSeq: this.nextSeq, gap: true, facts: [] }
    }
    return {
      epoch: this.epochId,
      headSeq: this.nextSeq,
      gap: false,
      facts: this.facts.filter((fact) => fact.seq > lastSeenSeq)
    }
  }

  subscribe(listener: (fact: AgentStatusFact) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeWithReplay(
    listener: (fact: AgentStatusFact) => void,
    lastSeenSeq?: number,
    epoch?: string
  ): AgentStatusFactJournalRead & { unsubscribe: () => void } {
    // Registration and the synchronous read share one turn of the event loop,
    // so a fact cannot land between the replay boundary and live fan-out.
    this.listeners.add(listener)
    const replay = this.readSince(lastSeenSeq, epoch)
    return {
      ...replay,
      unsubscribe: () => this.listeners.delete(listener)
    }
  }
}
