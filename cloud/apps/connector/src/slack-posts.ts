import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'

// message: chat.postMessage; status: posted once, then edited in place; reaction: reactions.add;
// ephemeral: chat.postEphemeral, seen only by one person, with no ts to edit or look for.
export type SlackPostKind = 'message' | 'status' | 'reaction' | 'ephemeral'

export type SlackPlace = { teamId: string; channelId: string; threadTs: string }
// A Block Kit block, built in slack-prompt-cards.ts and passed to Slack as is.
export type SlackBlock = Record<string, unknown>

export type ClaimedPost = SlackPlace & {
  postId: string
  kind: SlackPostKind
  body: Record<string, unknown>
  rev: number
  attempts: number
  slackTs: string | null
  // Claimed back from a sender that never finished: it may already be in Slack.
  stale: boolean
  sentAt: number
  // This claim's lease end; every finish names it, so a sender whose lease ran out changes nothing.
  leaseUntil: number
}

const CLAIM_BATCH = 20
// A post still sending after this was abandoned (crash or a lost reply) and is checked again. It
// covers the worst send (a bounded history check plus the post), as a claimed batch goes in parallel.
const SENDING_LEASE_MS = 120_000
const MAX_ATTEMPTS = 5
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 60_000

// States: queued -> sending -> posted, or failed / uncertain / cancelled. Each channel sends only its
// head (oldest queued_at), one at a time, so a head told to wait by Slack holds the whole channel.
// No other pacing: dogfood volume is small and Slack tolerates bursts; a rare 429 re-establishes the
// wait, and a head that is cancelled or given up takes its wait with it.
export class SlackPosts {
  constructor(
    private readonly database: CloudDatabase,
    private readonly now: () => number
  ) {}

  // Idempotent by post id: a retried caller queues nothing new.
  async queue(
    transaction: CloudDatabase,
    post: SlackPlace & {
      postId: string
      kind: Exclude<SlackPostKind, 'status'>
      body: Record<string, unknown>
      turnKey?: string
      delayMs?: number
    }
  ): Promise<void> {
    const now = this.now()
    const dueAt = now + (post.delayMs ?? 0)
    await transaction.query(
      `INSERT INTO connector_slack_posts
       (post_id, team_id, channel_id, thread_ts, kind, body, turn_key, rev, state, attempts,
        queued_at, next_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'queued', 0, ?, ?, ?) ON CONFLICT (post_id) DO NOTHING`,
      [
        post.postId,
        post.teamId,
        post.channelId,
        post.threadTs,
        post.kind,
        JSON.stringify(post.body),
        post.turnKey ?? null,
        dueAt,
        dueAt,
        now
      ]
    )
  }

  // A changed text bumps rev. A finished row rejoins the back of its channel's queue; a queued or
  // sending one keeps its place, and a sender holding an older rev leaves it queued for one more edit.
  // A text change never erases a delivery outcome: an uncertain status stays so, and stops editing.
  async setStatus(
    transaction: CloudDatabase,
    status: SlackPlace & { postId: string; text: string; blocks?: SlackBlock[] }
  ): Promise<void> {
    const now = this.now()
    await transaction.query(
      `INSERT INTO connector_slack_posts
       (post_id, team_id, channel_id, thread_ts, kind, body, rev, state, attempts, queued_at,
        next_at, updated_at)
       VALUES (?, ?, ?, ?, 'status', ?, 0, 'queued', 0, ?, ?, ?)
       ON CONFLICT (post_id) DO UPDATE SET body = excluded.body,
         rev = connector_slack_posts.rev + 1,
         attempts = CASE WHEN connector_slack_posts.state = 'sending'
           THEN connector_slack_posts.attempts ELSE 0 END,
         queued_at = CASE WHEN connector_slack_posts.state IN ('queued', 'sending')
           THEN connector_slack_posts.queued_at ELSE excluded.queued_at END,
         next_at = CASE WHEN connector_slack_posts.state IN ('queued', 'sending')
           THEN connector_slack_posts.next_at ELSE excluded.next_at END,
         state = CASE WHEN connector_slack_posts.state = 'sending' THEN 'sending' ELSE 'queued' END
       WHERE connector_slack_posts.body <> excluded.body
         AND connector_slack_posts.state <> 'uncertain'`,
      [
        status.postId,
        status.teamId,
        status.channelId,
        status.threadTs,
        JSON.stringify({ text: status.text, ...(status.blocks ? { blocks: status.blocks } : {}) }),
        now,
        now,
        now
      ]
    )
  }

  async hasReplyForTurn(transaction: CloudDatabase, turnKey: string): Promise<boolean> {
    const [row] = await transaction.query(
      `SELECT 1 AS found FROM connector_slack_posts
       WHERE turn_key = ? AND post_id LIKE 'reply:%' LIMIT 1`,
      [turnKey]
    )
    return row !== undefined
  }

  // A reply in a turn makes its fallback post unnecessary, if that hasn't gone out yet.
  async cancelQueued(transaction: CloudDatabase, postId: string): Promise<void> {
    await transaction.query(
      `UPDATE connector_slack_posts SET state = 'cancelled', body = '{}', updated_at = ?
       WHERE post_id = ? AND state = 'queued'`,
      [this.now(), postId]
    )
  }

  async find(
    transaction: CloudDatabase,
    postId: string
  ): Promise<{ state: string; slackTs: string | null } | null> {
    const [row] = await transaction.query(
      'SELECT state, slack_ts FROM connector_slack_posts WHERE post_id = ?',
      [postId]
    )
    return row ? { state: String(row.state), slackTs: nullableText(row.slack_ts) } : null
  }

  // One claimer at a time across instances, so a channel's head is claimed once per lease.
  async claim(): Promise<ClaimedPost[]> {
    return await this.database.transaction(async (transaction) => {
      if (!(await transaction.tryLockScope('orca-connector-slack-posts-claim'))) {
        return []
      }
      const now = this.now()
      const heads = await transaction.query(
        `SELECT * FROM connector_slack_posts p
         WHERE p.state IN ('queued', 'sending') AND p.next_at <= ?
           AND NOT EXISTS (SELECT 1 FROM connector_slack_posts ahead
             WHERE ahead.channel_id = p.channel_id AND ahead.state IN ('queued', 'sending')
               AND (ahead.queued_at < p.queued_at
                 OR (ahead.queued_at = p.queued_at AND ahead.post_id < p.post_id)))
         ORDER BY p.next_at LIMIT ?`,
        [now, CLAIM_BATCH]
      )
      const claimed: ClaimedPost[] = []
      for (const row of heads) {
        const stale = row.state === 'sending'
        const sentAt = stale ? Number(row.updated_at) : now
        const leaseUntil = now + SENDING_LEASE_MS
        // Only from the state it was read in: a reply's cancel since then stays final.
        const [taken] = await transaction.query(
          `UPDATE connector_slack_posts SET state = 'sending', attempts = attempts + 1,
             next_at = ?, updated_at = ?
           WHERE post_id = ? AND state = ? AND next_at = ?`,
          [leaseUntil, sentAt, row.post_id, row.state, row.next_at]
        )
        if (Number(taken?.changes ?? 0) > 0) {
          claimed.push(claimedPost(row, { stale, sentAt, leaseUntil }))
        }
      }
      return claimed
    })
  }

  // A sent one-off post keeps only its id and verdict; its text goes.
  async posted(post: ClaimedPost, slackTs?: string): Promise<void> {
    await this.database.query(
      `UPDATE connector_slack_posts
       SET state = CASE WHEN rev = ? THEN 'posted' ELSE 'queued' END, attempts = 0,
         body = CASE WHEN kind = 'status' THEN body ELSE '{}' END,
         slack_ts = COALESCE(?, slack_ts), queued_at = ?, next_at = ?, updated_at = ?
       WHERE post_id = ? AND state = 'sending' AND next_at = ?`,
      [post.rev, slackTs ?? null, this.now(), this.now(), this.now(), post.postId, post.leaseUntil]
    )
  }

  // A post found already in Slack after a lost reply. A status's found copy may hold older text than
  // the row, so it goes back in the queue for one edit.
  async found(post: ClaimedPost, slackTs: string): Promise<void> {
    if (post.kind !== 'status') {
      await this.posted(post, slackTs)
      return
    }
    await this.database.query(
      `UPDATE connector_slack_posts SET state = 'queued', attempts = 0, slack_ts = ?, next_at = ?,
         updated_at = ?
       WHERE post_id = ? AND state = 'sending' AND next_at = ?`,
      [slackTs, this.now(), this.now(), post.postId, post.leaseUntil]
    )
  }

  // The post stays its channel's head, so Slack's Retry-After holds everything queued behind it.
  async retry(post: ClaimedPost, afterMs?: number): Promise<void> {
    if (post.attempts >= MAX_ATTEMPTS) {
      await this.settle(post, 'failed')
      return
    }
    const now = this.now()
    const nextAt =
      now + (afterMs ?? Math.min(RETRY_BASE_MS * 2 ** (post.attempts - 1), RETRY_MAX_MS))
    await this.database.query(
      `UPDATE connector_slack_posts SET state = 'queued', next_at = ?, updated_at = ?
       WHERE post_id = ? AND state = 'sending' AND next_at = ?`,
      [nextAt, now, post.postId, post.leaseUntil]
    )
  }

  // failed: Slack refused it. uncertain: it may have posted and we couldn't check, so no retry.
  async settle(post: ClaimedPost, state: 'failed' | 'uncertain'): Promise<boolean> {
    const [settled] = await this.database.query(
      `UPDATE connector_slack_posts SET state = ?, updated_at = ?,
         body = CASE WHEN kind = 'status' THEN body ELSE '{}' END
       WHERE post_id = ? AND state = 'sending' AND next_at = ?`,
      [state, this.now(), post.postId, post.leaseUntil]
    )
    return Number(settled?.changes ?? 0) > 0
  }

  // Status rows stay while their thread may still be edited; a finished one-off post's id keeps a
  // retried reply or a repeated pause notice from posting twice until it goes.
  async pruneFinished(retentionMs: number): Promise<number> {
    const [result] = await this.database.query(
      `DELETE FROM connector_slack_posts
       WHERE kind <> 'status' AND state IN ('posted', 'failed', 'uncertain', 'cancelled')
         AND updated_at < ?`,
      [this.now() - retentionMs]
    )
    return Number(result?.changes ?? 0)
  }
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function claimedPost(
  row: SqlRow,
  claim: { stale: boolean; sentAt: number; leaseUntil: number }
): ClaimedPost {
  const kind = String(row.kind)
  if (kind !== 'message' && kind !== 'status' && kind !== 'reaction' && kind !== 'ephemeral') {
    throw new Error('unknown Slack post kind')
  }
  const body: unknown = JSON.parse(String(row.body))
  if (typeof body !== 'object' || body === null) {
    throw new Error('unreadable Slack post body')
  }
  return {
    postId: String(row.post_id),
    teamId: String(row.team_id),
    channelId: String(row.channel_id),
    threadTs: String(row.thread_ts),
    kind,
    body: Object.fromEntries(Object.entries(body)),
    rev: Number(row.rev),
    attempts: Number(row.attempts) + 1,
    slackTs: nullableText(row.slack_ts),
    ...claim
  }
}
