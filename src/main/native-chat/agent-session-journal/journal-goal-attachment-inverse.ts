import type Database from '../../sqlite/sync-database'
import type { JournalOperationReceipt } from './journal-row-writer'

/** Losing this live proof revokes permission to retract a durable claim. */
export class JournalGoalAttachmentInverse {
  private readonly uploads = new Map<string, Set<string>>()
  private readonly goals = new Map<string, ReadonlySet<string>>()

  constructor(private readonly sessionId: string) {}

  isLive(goalId: string): boolean {
    return this.goals.has(goalId)
  }

  acquired(referenced: ReadonlySet<string>, inserted: readonly string[], goalId?: string): void {
    if (!goalId) {
      for (const id of referenced) {
        this.uploads.delete(id)
      }
      return
    }
    this.goals.set(goalId, referenced)
    for (const id of inserted) {
      this.uploads.set(id, new Set())
    }
    for (const id of referenced) {
      this.uploads.get(id)?.add(goalId)
    }
  }

  keep(goalId: string): void {
    for (const id of this.goals.get(goalId) ?? []) {
      this.uploads.delete(id)
    }
    this.goals.delete(goalId)
  }

  withdraw(goalId: string): JournalOperationReceipt {
    const next = new Map<string, Set<string>>()
    return {
      write: (db: Database.Database) => {
        next.clear()
        for (const id of this.goals.get(goalId) ?? []) {
          const live = this.uploads.get(id)
          if (!live?.has(goalId)) {
            continue
          }
          const remaining = new Set(live)
          remaining.delete(goalId)
          next.set(id, remaining)
          if (remaining.size === 0) {
            db.prepare(
              'DELETE FROM agent_session_attachment_claims WHERE upload_id = ? AND session_id = ?'
            ).run(id, this.sessionId)
          }
        }
      },
      committed: () => {
        for (const [id, remaining] of next) {
          if (remaining.size) {
            this.uploads.set(id, remaining)
          } else {
            this.uploads.delete(id)
          }
        }
        this.goals.delete(goalId)
      }
    }
  }
}
