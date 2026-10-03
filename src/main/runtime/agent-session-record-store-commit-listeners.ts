// Who the record store tells, once a transaction commits, of what it changed: each session it wrote
// a proof of death for, and its first chat. Kept apart from the transaction itself, which only asks
// it to watch the draft it applies.

import type { AgentSessionStoreState } from './agent-session-record-store-file'

export class AgentSessionRecordStoreCommitListeners {
  private readonly deathEvidence = new Set<(sessionId: string) => void>()
  private readonly firstRecord = new Set<() => void>()

  /** Every transition that writes a proof of death lands here. Must not throw. */
  onDeathEvidence(listener: (sessionId: string) => void): () => void {
    this.deathEvidence.add(listener)
    return () => this.deathEvidence.delete(listener)
  }

  /** Must not throw. */
  onFirstRecord(listener: () => void): () => void {
    this.firstRecord.add(listener)
    return () => this.firstRecord.delete(listener)
  }

  /** Applies one transaction's change to its draft, noting what to tell once it commits. */
  watch<T>(
    holdsRecords: () => boolean,
    draft: AgentSessionStoreState,
    apply: (draft: AgentSessionStoreState) => T
  ): { result: T; notify: () => void } {
    const heldBefore = holdsRecords()
    if (this.deathEvidence.size === 0) {
      return {
        result: apply(draft),
        notify: () => this.notifyFirstRecord(heldBefore, holdsRecords)
      }
    }
    const before = new Map(
      [...draft.records].map(([id, record]) => [id, record.lease.deathEvidence])
    )
    const result = apply(draft)
    const proven = [...draft.records]
      .filter(([id, { lease }]) => lease.deathEvidence && lease.deathEvidence !== before.get(id))
      .map(([id]) => id)
    return {
      result,
      notify: () => {
        for (const sessionId of proven) {
          this.deathEvidence.forEach((listener) => listener(sessionId))
        }
        this.notifyFirstRecord(heldBefore, holdsRecords)
      }
    }
  }

  private notifyFirstRecord(heldBefore: boolean, holdsRecords: () => boolean): void {
    if (!heldBefore && holdsRecords()) {
      this.firstRecord.forEach((listener) => listener())
    }
  }
}
