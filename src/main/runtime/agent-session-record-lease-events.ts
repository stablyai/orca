// What a record-store transaction did to leases that listeners outside the store wait on.

import type { AgentSessionRecord } from '../../shared/agent-session-record'

type Lease = AgentSessionRecord['lease']

/** Listeners keyed by event, each told the session the event happened to. */
export class AgentSessionLeaseEventListeners {
  readonly deathEvidence = new Set<(sessionId: string) => void>()
  private readonly handoffEnded = new Set<(sessionId: string) => void>()

  onHandoffEnded = (listener: (sessionId: string) => void): (() => void) => {
    this.handoffEnded.add(listener)
    return () => this.handoffEnded.delete(listener)
  }

  get empty(): boolean {
    return this.deathEvidence.size === 0 && this.handoffEnded.size === 0
  }

  /** Read inside the transaction: each session it wrote a new proof of death for, and each whose
   *  handoff it ended. */
  collect(before: ReadonlyMap<string, Lease>, records: ReadonlyMap<string, AgentSessionRecord>) {
    const events: { deathEvidence: string[]; handoffEnded: string[] } = {
      deathEvidence: [],
      handoffEnded: []
    }
    for (const [sessionId, { lease }] of records) {
      const prior = before.get(sessionId)
      if (lease.deathEvidence && lease.deathEvidence !== prior?.deathEvidence) {
        events.deathEvidence.push(sessionId)
      }
      if (handoffInFlight(prior) && !handoffInFlight(lease)) {
        events.handoffEnded.push(sessionId)
      }
    }
    return events
  }

  /** Once the transaction committed, so a listener may read the store. */
  notify(events: ReturnType<AgentSessionLeaseEventListeners['collect']>): void {
    for (const sessionId of events.deathEvidence) {
      this.deathEvidence.forEach((listener) => listener(sessionId))
    }
    for (const sessionId of events.handoffEnded) {
      this.handoffEnded.forEach((listener) => listener(sessionId))
    }
  }
}

function handoffInFlight(lease: Lease | undefined): boolean {
  return Boolean(lease?.handoffStage || lease?.handoffOperationId)
}
