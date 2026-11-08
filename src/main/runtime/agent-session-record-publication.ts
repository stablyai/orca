import type { AgentSessionStoreCommand } from './agent-session/records/agent-session-store-command'
import type { AgentSessionStoreTransactions } from './agent-session/records/agent-session-store-transactions'
import type { AgentSessionRecordCommand } from './agent-session/records/agent-session-record-command'
import { isDeepStrictEqual } from 'node:util'

export abstract class AgentSessionRecordPublication {
  constructor(protected readonly transactions: AgentSessionStoreTransactions) {}
  abstract holdsRecords(): boolean
  private readonly deathEvidenceListeners = new Set<(sessionId: string) => void>()

  protected readonly firstRecordListeners = new Set<() => void>()

  /** Notify committed death evidence from every transition; listeners must not throw. */
  onDeathEvidence(listener: (sessionId: string) => void): () => void {
    this.deathEvidenceListeners.add(listener)
    return () => this.deathEvidenceListeners.delete(listener)
  }

  /** Notify first committed record; listeners must not throw. */
  onFirstRecord(listener: () => void): () => void {
    this.firstRecordListeners.add(listener)
    return () => this.firstRecordListeners.delete(listener)
  }

  protected async commitRecordCommand<C extends AgentSessionRecordCommand>(
    id: string,
    command: C,
    check?: () => void
  ) {
    const before = this.transactions.state.records.get(id)?.lease.deathEvidence
    const result = await this.transactions.record(id, command, check)
    const after = this.transactions.state.records.get(id)?.lease.deathEvidence
    if (after && !isDeepStrictEqual(before, after)) {
      this.deathEvidenceListeners.forEach((listener) => listener(id))
    }
    return result
  }

  protected async commitStoreCommand<C extends AgentSessionStoreCommand>(
    command: C,
    check?: () => void
  ) {
    const before = new Map(
      [...this.transactions.state.records].map(([id, record]) => [id, record.lease.deathEvidence])
    )
    const heldBefore = this.holdsRecords()
    const result = await this.transactions.command(command, check)
    for (const [id, record] of this.transactions.state.records) {
      if (
        record.lease.deathEvidence &&
        !isDeepStrictEqual(before.get(id), record.lease.deathEvidence)
      ) {
        this.deathEvidenceListeners.forEach((listener) => listener(id))
      }
    }
    if (!heldBefore && this.holdsRecords()) {
      this.firstRecordListeners.forEach((listener) => listener())
    }
    return result
  }
}
