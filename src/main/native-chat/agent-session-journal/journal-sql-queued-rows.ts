import type { JournalQueuedRowStorage } from './journal-index-storage'
import { JournalSqlKeyedMap } from './journal-sql-keyed-values'
import type { JournalSqlValueContext } from './journal-sql-value-context'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'

const PAGE = 64

/** Live rows are the typed current-card members, read in (position, message id) order. */
export class JournalSqlQueuedRows implements JournalQueuedRowStorage {
  private readonly rows: JournalSqlKeyedMap<string, QueuedMessageRow>
  constructor(private readonly context: JournalSqlValueContext) {
    this.rows = new JournalSqlKeyedMap(context, 'cards.current')
  }

  set(card: QueuedMessageRow, live: boolean): boolean {
    const prior = this.rows.get(card.messageId)
    if ((prior === card && live) || (!prior && !live)) {
      return false
    }
    if (live) {
      this.rows.set(card.messageId, card)
    } else {
      this.rows.delete(card.messageId)
    }
    return true
  }

  head(): QueuedMessageRow | undefined {
    return this.page(undefined, 1)[0]
  }

  *values(after?: QueuedMessageRow): Generator<QueuedMessageRow> {
    let cursor = after
    for (;;) {
      const page = this.page(cursor, PAGE)
      yield* page
      if (page.length < PAGE) {
        return
      }
      cursor = page.at(-1)
    }
  }

  private page(after: QueuedMessageRow | undefined, limit: number): QueuedMessageRow[] {
    const { scope } = this.context
    const rows = after
      ? scope.db
          .prepare(`SELECT message_id FROM journal_proj_current_cards
            WHERE session_id=? AND epoch=? AND current=1
              AND (position>? OR (position=? AND message_id>?))
            ORDER BY position, message_id LIMIT ?`)
          .all(...scope.prefix, after.position, after.position, after.messageId, limit)
      : scope.db
          .prepare(`SELECT message_id FROM journal_proj_current_cards
            WHERE session_id=? AND epoch=? AND current=1
            ORDER BY position, message_id LIMIT ?`)
          .all(...scope.prefix, limit)
    return rows.map((row) => this.rows.get(String(scope.examined(row).message_id))!)
  }
}
