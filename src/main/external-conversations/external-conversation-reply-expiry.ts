import { createHash } from 'node:crypto'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorFailure } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import {
  replyExpiry,
  replyExpiryReason,
  type ReplyExpiry,
  type ReplyPolicy
} from './connector-reply-policy'

// Recovery's fills that may be too old to post (design: slack-reply-lost-restart, D2 §4). A row too
// old is filled `quiet`: the cloud closes its request and posts nothing; why stays in the row.

export type ExpiringRow = { row: JournalConnectorReplyRow; expiry: ReplyExpiry; outcome: string }

type Row = JournalConnectorReplyRow

export class ReplyExpiries {
  private count = 0

  constructor(
    private readonly now: () => number,
    private readonly policy: () => ReplyPolicy
  ) {}

  /** Rows settled quietly in this process. */
  get expired(): number {
    return this.count
  }

  /** Whether a recovered fill is too old to post: its resolving event or its request. */
  expiryOf(resolvedAt: number | undefined, admittedAt: number | undefined): ReplyExpiry | null {
    return replyExpiry({ resolvedAt, admittedAt, now: this.now() }, this.policy())
  }

  /** Settles rows quietly, each with its reason; a warn per row says so in the log. */
  async expire(
    journal: ConnectorReplyJournal,
    sessionId: string,
    expiring: readonly ExpiringRow[]
  ): Promise<void> {
    if (expiring.length === 0) {
      return
    }
    const now = this.now()
    await journal.fillOutcomes(
      expiring.map(({ row, expiry, outcome }) => ({
        account: row.account,
        deliveryId: row.deliveryId,
        outcome: 'quiet',
        answerDeliveryId: row.deliveryId,
        expiredReason: replyExpiryReason(expiry, outcome, now)
      }))
    )
    for (const { row, expiry } of expiring) {
      this.count += 1
      console.warn('[connector] settled a Slack reply without posting it', {
        sessionId,
        delivery: createHash('sha256').update(row.deliveryId).digest('hex').slice(0, 12),
        reason: expiry.kind
      })
    }
  }

  /** Fills rows with an outcome of their own, or quietly when too old to post. resolvedAt: when the
   *  outcome happened (null: never posted, so never too old; undefined: request age alone). */
  async fillOrExpire(
    journal: ConnectorReplyJournal,
    rows: readonly Row[],
    outcome: 'not_found' | 'unattributed' | 'failed' | 'interrupted',
    times: {
      resolvedAt: ((row: Row) => number | undefined) | null
      admittedAt: (row: Row) => number | undefined
    },
    failureOf?: (row: Row) => ConnectorFailure | undefined
  ): Promise<void> {
    const expiring: ExpiringRow[] = []
    const posting: Row[] = []
    for (const row of rows) {
      const expiry =
        times.resolvedAt === null
          ? null
          : this.expiryOf(times.resolvedAt(row), times.admittedAt(row))
      if (expiry) {
        expiring.push({ row, expiry, outcome })
      } else {
        posting.push(row)
      }
    }
    await this.expire(journal, rows[0]?.sessionId ?? '', expiring)
    await journal.fillOutcomes(
      posting.map((row) => {
        const failure = failureOf?.(row)
        return {
          account: row.account,
          deliveryId: row.deliveryId,
          outcome,
          answerDeliveryId: row.deliveryId,
          ...(failure ? { failure } : {})
        }
      })
    )
  }
}
