import {
  agentSessionClosedOwnerKey,
  type AgentSessionClosedOwner
} from './agent-session-closed-owner'
import type { AgentSessionStoreState } from './agent-session-store-state'

type DeathEvidenceListener = (sessionId: string, fact: AgentSessionClosedOwner | null) => void

/** Stages notifications with the draft and publishes their captured facts only after commit. */
export class AgentSessionStoreNotifications {
  private readonly deathEvidenceListeners = new Set<DeathEvidenceListener>()
  private readonly closedOwnerListeners = new Set<(fact: AgentSessionClosedOwner) => void>()
  private readonly firstRecordListeners = new Set<() => void>()

  onDeathEvidence = (listener: DeathEvidenceListener): (() => void) => {
    this.deathEvidenceListeners.add(listener)
    return () => this.deathEvidenceListeners.delete(listener)
  }

  onClosedOwner = (listener: (fact: AgentSessionClosedOwner) => void): (() => void) => {
    this.closedOwnerListeners.add(listener)
    return () => this.closedOwnerListeners.delete(listener)
  }

  onFirstRecord = (listener: () => void): (() => void) => {
    this.firstRecordListeners.add(listener)
    return () => this.firstRecordListeners.delete(listener)
  }

  stage<T>(
    draft: AgentSessionStoreState,
    apply: (draft: AgentSessionStoreState) => T
  ): { result: T; publish: (durable: boolean) => void } {
    const heldBefore = draft.records.size > 0 || draft.unreadableRecords.size > 0
    const beforeClosed =
      this.closedOwnerListeners.size > 0 ? new Set(draft.closedOwners.keys()) : null
    const beforeEvidence =
      this.deathEvidenceListeners.size > 0
        ? new Map([...draft.records].map(([id, record]) => [id, record.lease.deathEvidence]))
        : null
    const result = apply(draft)
    const proven = beforeEvidence
      ? [...draft.records]
          .filter(
            ([id, { lease }]) =>
              lease.deathEvidence && lease.deathEvidence !== beforeEvidence.get(id)
          )
          .map(([sessionId, record]) => ({
            sessionId,
            key:
              record.lease.deathEvidence?.ownerFence === undefined
                ? null
                : agentSessionClosedOwnerKey({
                    ...record,
                    deadOwnerFence: record.lease.deathEvidence.ownerFence
                  })
          }))
      : []
    return {
      result,
      publish: (durable) => {
        for (const { sessionId, key } of proven) {
          const fact = key === null ? null : (draft.closedOwners.get(key) ?? null)
          this.deathEvidenceListeners.forEach((listener) => listener(sessionId, fact))
        }
        if (durable && beforeClosed) {
          for (const [key, fact] of draft.closedOwners) {
            if (!beforeClosed.has(key)) {
              this.closedOwnerListeners.forEach((listener) => listener(fact))
            }
          }
        }
        if (!heldBefore && (draft.records.size > 0 || draft.unreadableRecords.size > 0)) {
          this.firstRecordListeners.forEach((listener) => listener())
        }
      }
    }
  }
}
