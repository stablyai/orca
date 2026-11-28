import type { ConnectorFailure } from '../../../../shared/connectors/connector-cloud-contract'
import type {
  JournalConnectorReplyCut,
  JournalConnectorReplyCutRows,
  JournalConnectorReplyFill,
  JournalConnectorReplyKey,
  JournalConnectorReplyRetryRows,
  JournalConnectorReplyRow
} from '../../../../shared/agent-session/journal/journal-connector-reply'
import type { JournalSqlDatabase } from '../database/journal-sql-database'
import type { JournalSqlMaintenance } from '../journal-sql-maintenance'

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

  /** Whether a turn's answer to one conversation is still unsent (a leave's line waits for it). */
  async unsentAnswer(
    sessionId: string,
    conversation: { source: string; externalId: string },
    turnStartedAt: number
  ): Promise<boolean> {
    const result = await this.db.readers.database({
      kind: 'connector-reply-unsent',
      sessionId,
      conversation,
      turnStartedAt
    })
    if (result.kind !== 'connector-reply-unsent') {
      throw new Error('journal reader returned no unsent answer check')
    }
    return result.unsent
  }

  /** One page of an account's filled, unsent rows after a delivery id (null: from the start). */
  async readOwed(
    account: string,
    after: string | null,
    limit: number
  ): Promise<JournalConnectorReplyRow[]> {
    const result = await this.db.readers.database({
      kind: 'connector-replies-owed',
      account,
      after,
      limit
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

  /** Open rows a cut now owes a continuation; whether any changed. */
  async cut(rows: JournalConnectorReplyCutRows): Promise<boolean> {
    return await this.maintain({ kind: 'connector-replies-cut', rows }, rows.keys.length)
  }

  /** The continuation's own turn was cut and is owed again: its claimed rows become that cut's. */
  async recut(
    claimMessageId: string,
    cut: JournalConnectorReplyCut,
    failure?: ConnectorFailure
  ): Promise<boolean> {
    return await this.maintain({ kind: 'connector-replies-recut', claimMessageId, cut, failure })
  }

  /** An empty turn's rows, held for its one retry to claim; whether any changed. */
  async holdForRetry(rows: JournalConnectorReplyRetryRows): Promise<boolean> {
    return await this.maintain(
      { kind: 'connector-replies-retry-hold', rows },
      rows.keys.length + rows.claims.length
    )
  }

  /** The claiming message never became the continuation: its rows are their cut's again. */
  async releaseClaim(claimMessageId: string): Promise<boolean> {
    return await this.maintain({ kind: 'connector-replies-release', claimMessageId })
  }

  private async maintain(operation: JournalSqlMaintenance, size = 1): Promise<boolean> {
    if (this.db.readOnly || size === 0) {
      return false
    }
    return (await this.db.serialize(LANE, (writer) => writer.maintain(operation))) === true
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
