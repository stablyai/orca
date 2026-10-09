// What the reconciliation keeps of a chat between its workers, in memory only: nothing here is
// owed past the process, and all of it goes with the chat's record.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionReconciliationDebts } from './structured-agent-session-reconciliation-pass'

export class StructuredAgentSessionReconciliationMemory {
  /** Proofs a retired worker still held (a lease in recovery, or a run given up), for the next
   *  one; dropped once taken. An exit's account is not kept: it judges only its own generation,
   *  which a later one may have replaced by then. */
  private readonly parked = new Map<string, StructuredAgentSessionReconciliationDebts>()
  /** Where this host process first opened each chat's journal: every send at or before it was
   *  accepted by an earlier host process, every one after by this. Kept for the whole process (a
   *  close or a retire must not reset it, or this process's sends would read as an earlier one's). */
  private readonly firstOpened = new Map<string, AgentJournalCursor>()

  park(sessionId: string, debts: StructuredAgentSessionReconciliationDebts): void {
    if (debts.evidence) {
      this.parked.set(sessionId, { evidence: debts.evidence })
    }
  }

  take(sessionId: string): StructuredAgentSessionReconciliationDebts {
    const debts = this.parked.get(sessionId) ?? {}
    this.parked.delete(sessionId)
    return debts
  }

  noteOpened(sessionId: string, journal: Pick<AgentSessionJournal, 'openedAt'>): void {
    if (!this.firstOpened.has(sessionId)) {
      this.firstOpened.set(sessionId, journal.openedAt())
    }
  }

  processOpened(sessionId: string): AgentJournalCursor | undefined {
    return this.firstOpened.get(sessionId)
  }

  /** The chat's record is gone. */
  forget(sessionId: string): void {
    this.parked.delete(sessionId)
    this.firstOpened.delete(sessionId)
  }
}
