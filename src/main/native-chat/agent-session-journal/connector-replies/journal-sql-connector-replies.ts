import type {
  JournalConnectorReplyFill,
  JournalConnectorReplyKey,
  JournalConnectorReplyRow
} from '../../../../shared/agent-session/journal/journal-connector-reply'
import type { JournalSqlDatabase } from '../database/journal-sql-database'

// Writes share one lane of their own on the writer worker; reads use the reader pool.
const LANE = 'journal.connector-replies'

/** The reply outbox's rows outside any chat's lane: never SQL on Electron main. */
export class JournalSqlConnectorReplies {
  constructor(
    private readonly db: Pick<JournalSqlDatabase, 'readers' | 'serialize' | 'readOnly'>
  ) {}

  /** Rows not yet accepted: one chat's, or all of them. */
  async read(sessionId?: string): Promise<JournalConnectorReplyRow[]> {
    const result = await this.db.readers.database({
      kind: 'connector-replies',
      ...(sessionId === undefined ? {} : { sessionId })
    })
    if (result.kind !== 'connector-replies') {
      throw new Error('journal reader returned no connector replies')
    }
    return result.rows
  }

  /** Fills rows with their outcomes, the first fill winning; whether any changed. */
  async fillOutcomes(fills: readonly JournalConnectorReplyFill[]): Promise<boolean> {
    if (this.db.readOnly || fills.length === 0) {
      return false
    }
    const result = await this.db.serialize(LANE, (writer) =>
      writer.maintain({ kind: 'connector-replies-fill', fills, now: Date.now() })
    )
    return result === true
  }

  /** The cloud accepted these rows. */
  async sent(keys: readonly JournalConnectorReplyKey[]): Promise<void> {
    if (!this.db.readOnly && keys.length > 0) {
      await this.db.serialize(LANE, (writer) =>
        writer.maintain({ kind: 'connector-replies-sent', keys, now: Date.now() })
      )
    }
  }
}
