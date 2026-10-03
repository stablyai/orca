// A journal store's fold and the one way to read it. A failed append whose undo could not put the
// fold back marks it stale; the next read re-folds it from what committed, so no reader or writer
// gets a fold the disk never held.

import type { JournalHostDatabase } from './journal-host-database'
import { replayJournal } from './journal-open'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'

export class JournalFoldHolder {
  private fold: JournalReducerState
  private stale = false

  constructor(
    private readonly sessionId: string,
    private readonly database: JournalHostDatabase
  ) {
    this.fold = createJournalReducerState(sessionId, '')
  }

  get(): JournalReducerState {
    if (this.stale) {
      const { db } = this.database
      if (db.isTransaction) {
        // A transaction would read its own uncommitted rows back as the fold.
        throw new Error(`agent-session journal ${this.sessionId} is stale mid-transaction`)
      }
      const reloaded = replayJournal(db, this.sessionId)
      if (!reloaded) {
        throw new Error(`agent-session journal ${this.sessionId} is gone`)
      }
      this.set(reloaded.state)
    }
    return this.fold
  }

  set(fold: JournalReducerState): void {
    this.fold = fold
    this.stale = false
  }

  markStale(): void {
    this.stale = true
  }
}
