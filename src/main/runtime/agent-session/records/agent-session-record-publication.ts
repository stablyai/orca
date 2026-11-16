import type { AgentSessionStoreCommand } from './agent-session-store-command'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import type { AgentSessionRecordCommand } from './agent-session-record-command'

export abstract class AgentSessionRecordPublication {
  constructor(protected readonly transactions: AgentSessionStoreTransactions) {}
  abstract holdsRecords(): boolean

  /** Notify committed death evidence from every transition; listeners must not throw. */
  onDeathEvidence(listener: (sessionId: string) => void): () => void {
    this.transactions.deathEvidenceListeners.add(listener)
    return () => this.transactions.deathEvidenceListeners.delete(listener)
  }

  /** Notify first committed record; listeners must not throw. */
  onFirstRecord(listener: () => void): () => void {
    this.transactions.firstRecordListeners.add(listener)
    return () => this.transactions.firstRecordListeners.delete(listener)
  }

  protected commitRecordCommand<C extends AgentSessionRecordCommand>(
    id: string,
    command: C,
    check?: () => void
  ) {
    return this.transactions.record(id, command, check)
  }

  protected commitStoreCommand<C extends AgentSessionStoreCommand>(command: C, check?: () => void) {
    return this.transactions.command(command, check)
  }
}
