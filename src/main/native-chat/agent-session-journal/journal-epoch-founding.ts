// A chat opened with no journal yet. Opening it writes nothing: its first epoch row is held here,
// in memory, and lands in the transaction of the first row the chat writes. A crash before then
// leaves no journal, exactly as before the open, and the next open mints a new epoch.

import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type Database from '../../sqlite/sync-database'
import type { JournalLoad } from './journal-open'
import { journalOpenRefusalError } from './journal-open-failure'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { insertJournalRow, publishJournalSessionEpoch } from './journal-row-table'
import type { JournalRow } from './journal-row-schema'

export class JournalEpochFounding {
  private pending: JournalRow | null = null

  constructor(private readonly identity: AgentSessionJournalIdentity) {}

  /** The empty journal a reader sees until the first write founds it. */
  hold(epoch: string, now: number): JournalLoad {
    const row: JournalRow = {
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: agentSessionJournalProviderHandle(this.identity),
      v: journalRowSchemaVersion([]),
      epoch,
      seq: 1,
      fence: 0,
      ts: now
    }
    const state = createJournalReducerState(this.identity.sessionId, epoch)
    applyJournalRow(state, row)
    state.oldestSequence = 1
    this.pending = row
    return { state, newer: null, damage: null }
  }

  /** Whether the epoch still waits for its first write. */
  held(): boolean {
    return this.pending !== null
  }

  /** First inside a transaction that writes the chat's rows: a rollback takes the epoch with it.
   *  Its own failure is the journal's open failing, as an eager open's would have been. */
  inTransaction(db: Database.Database): void {
    if (!this.pending) {
      return
    }
    try {
      insertJournalRow(db, this.identity.sessionId, this.pending)
      publishJournalSessionEpoch(db, this.identity, this.pending.epoch)
    } catch (error) {
      throw journalOpenRefusalError(error)
    }
  }

  /** The transaction that carried the epoch committed, or another epoch replaced it. */
  settled(): void {
    this.pending = null
  }
}
