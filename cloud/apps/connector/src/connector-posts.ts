import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import type { ConnectorSource, ThreadPlace } from './connector-adapter.js'

// message: a new post in the thread; status: posted once, then edited in place; reaction: on the
// person's message; ephemeral: seen only by one person, with no id to edit or look for.
export type PostKind = 'message' | 'status' | 'reaction' | 'ephemeral'

// In the source's own format, built by its adapter and sent by it as is.
export type PostBody = Record<string, unknown>

export type ClaimedPost = ThreadPlace & {
  postId: string
  kind: PostKind
  body: PostBody
  rev: number
  attempts: number
  // The posted message's id in the source, once known.
  messageRef: string | null
  // Claimed back from a sender that never finished: it may already be in the source.
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

// One source's outbox. States: queued -> sending -> posted, or failed / uncertain / cancelled. Each
// container (channel) sends only its head (oldest queued_at), one at a time, so a head told to wait
// holds the whole container. No other pacing: dogfood volume is small and sources tolerate bursts;
// a rare 429 re-establishes the wait, and a head that is cancelled or given up takes its wait with it.
export class ConnectorPosts {
  constructor(
    private readonly database: CloudDatabase,
    private readonly now: () => number,
    readonly source: ConnectorSource
  ) {}

  // Idempotent by post id: a retried caller queues nothing new.
  async queue(
    transaction: CloudDatabase,
    post: ThreadPlace & {
      postId: string
      kind: Exclude<PostKind, 'status'>
      body: PostBody
      turnKey?: string
      delayMs?: number
    }
  ): Promise<void> {
    const now = this.now()
    const dueAt = now + (post.delayMs ?? 0)
    await transaction.query(
      `INSERT INTO connector_posts
       (source, post_id, workspace_id, container_id, thread_id, kind, body, turn_key, rev, state,
        attempts, queued_at, next_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'queued', 0, ?, ?, ?)
       ON CONFLICT (source, post_id) DO NOTHING`,
      [
        this.source,
        post.postId,
        post.workspaceId,
        post.containerId,
        post.threadId,
        post.kind,
        JSON.stringify(post.body),
        post.turnKey ?? null,
        dueAt,
        dueAt,
        now
      ]
    )
  }

  // A changed body bumps rev. A finished row rejoins the back of its container's queue; a queued or
  // sending one keeps its place, and a sender holding an older rev leaves it queued for one more edit.
  // A body change never erases a delivery outcome: an uncertain status stays so, and stops editing.
  async setStatus(
    transaction: CloudDatabase,
    status: ThreadPlace & { postId: string; body: PostBody }
  ): Promise<void> {
    const now = this.now()
    await transaction.query(
      `INSERT INTO connector_posts
       (source, post_id, workspace_id, container_id, thread_id, kind, body, rev, state, attempts,
        queued_at, next_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'status', ?, 0, 'queued', 0, ?, ?, ?)
       ON CONFLICT (source, post_id) DO UPDATE SET body = excluded.body,
         rev = connector_posts.rev + 1,
         attempts = CASE WHEN connector_posts.state = 'sending'
           THEN connector_posts.attempts ELSE 0 END,
         queued_at = CASE WHEN connector_posts.state IN ('queued', 'sending')
           THEN connector_posts.queued_at ELSE excluded.queued_at END,
         next_at = CASE WHEN connector_posts.state IN ('queued', 'sending')
           THEN connector_posts.next_at ELSE excluded.next_at END,
         state = CASE WHEN connector_posts.state = 'sending' THEN 'sending' ELSE 'queued' END
       WHERE connector_posts.body <> excluded.body
         AND connector_posts.state <> 'uncertain'`,
      [
        this.source,
        status.postId,
        status.workspaceId,
        status.containerId,
        status.threadId,
        JSON.stringify(status.body),
        now,
        now,
        now
      ]
    )
  }

  async hasReplyForTurn(transaction: CloudDatabase, turnKey: string): Promise<boolean> {
    const [row] = await transaction.query(
      `SELECT 1 AS found FROM connector_posts
       WHERE source = ? AND turn_key = ? AND post_id LIKE 'reply:%' LIMIT 1`,
      [this.source, turnKey]
    )
    return row !== undefined
  }

  // A reply in a turn makes its fallback post unnecessary, if that hasn't gone out yet.
  async cancelQueued(transaction: CloudDatabase, postId: string): Promise<void> {
    await transaction.query(
      `UPDATE connector_posts SET state = 'cancelled', body = '{}', updated_at = ?
       WHERE source = ? AND post_id = ? AND state = 'queued'`,
      [this.now(), this.source, postId]
    )
  }

  async find(
    transaction: CloudDatabase,
    postId: string
  ): Promise<{ state: string; messageRef: string | null } | null> {
    const [row] = await transaction.query(
      'SELECT state, message_ref FROM connector_posts WHERE source = ? AND post_id = ?',
      [this.source, postId]
    )
    return row ? { state: String(row.state), messageRef: nullableText(row.message_ref) } : null
  }

  // One claimer at a time across instances, so a container's head is claimed once per lease.
  async claim(): Promise<ClaimedPost[]> {
    return await this.database.transaction(async (transaction) => {
      if (!(await transaction.tryLockScope(`orca-connector-posts-claim:${this.source}`))) {
        return []
      }
      const now = this.now()
      const heads = await transaction.query(
        `SELECT * FROM connector_posts p
         WHERE p.source = ? AND p.state IN ('queued', 'sending') AND p.next_at <= ?
           AND NOT EXISTS (SELECT 1 FROM connector_posts ahead
             WHERE ahead.source = p.source AND ahead.container_id = p.container_id
               AND ahead.state IN ('queued', 'sending')
               AND (ahead.queued_at < p.queued_at
                 OR (ahead.queued_at = p.queued_at AND ahead.post_id < p.post_id)))
         ORDER BY p.next_at LIMIT ?`,
        [this.source, now, CLAIM_BATCH]
      )
      const claimed: ClaimedPost[] = []
      for (const row of heads) {
        const stale = row.state === 'sending'
        const sentAt = stale ? Number(row.updated_at) : now
        const leaseUntil = now + SENDING_LEASE_MS
        // Only from the state it was read in: a reply's cancel since then stays final.
        const [taken] = await transaction.query(
          `UPDATE connector_posts SET state = 'sending', attempts = attempts + 1,
             next_at = ?, updated_at = ?
           WHERE source = ? AND post_id = ? AND state = ? AND next_at = ?`,
          [leaseUntil, sentAt, this.source, row.post_id, row.state, row.next_at]
        )
        if (Number(taken?.changes ?? 0) > 0) {
          claimed.push(claimedPost(row, { stale, sentAt, leaseUntil }))
        }
      }
      return claimed
    })
  }

  // A sent one-off post keeps only its id and verdict; its text goes.
  async posted(post: ClaimedPost, messageRef?: string): Promise<void> {
    await this.database.query(
      `UPDATE connector_posts
       SET state = CASE WHEN rev = ? THEN 'posted' ELSE 'queued' END, attempts = 0,
         body = CASE WHEN kind = 'status' THEN body ELSE '{}' END,
         message_ref = COALESCE(?, message_ref), queued_at = ?, next_at = ?, updated_at = ?
       WHERE source = ? AND post_id = ? AND state = 'sending' AND next_at = ?`,
      [
        post.rev,
        messageRef ?? null,
        this.now(),
        this.now(),
        this.now(),
        this.source,
        post.postId,
        post.leaseUntil
      ]
    )
  }

  // A post found already sent after a lost reply. A status's found copy may hold older text than the
  // row, so it goes back in the queue for one edit.
  async found(post: ClaimedPost, messageRef: string): Promise<void> {
    if (post.kind !== 'status') {
      await this.posted(post, messageRef)
      return
    }
    await this.database.query(
      `UPDATE connector_posts SET state = 'queued', attempts = 0, message_ref = ?, next_at = ?,
         updated_at = ?
       WHERE source = ? AND post_id = ? AND state = 'sending' AND next_at = ?`,
      [messageRef, this.now(), this.now(), this.source, post.postId, post.leaseUntil]
    )
  }

  // The post stays its container's head, so a source's Retry-After holds everything queued behind it.
  async retry(post: ClaimedPost, afterMs?: number): Promise<void> {
    if (post.attempts >= MAX_ATTEMPTS) {
      await this.settle(post, 'failed')
      return
    }
    const now = this.now()
    const nextAt =
      now + (afterMs ?? Math.min(RETRY_BASE_MS * 2 ** (post.attempts - 1), RETRY_MAX_MS))
    await this.database.query(
      `UPDATE connector_posts SET state = 'queued', next_at = ?, updated_at = ?
       WHERE source = ? AND post_id = ? AND state = 'sending' AND next_at = ?`,
      [nextAt, now, this.source, post.postId, post.leaseUntil]
    )
  }

  // failed: the source refused it. uncertain: it may have posted and we couldn't check, so no retry.
  async settle(post: ClaimedPost, state: 'failed' | 'uncertain'): Promise<boolean> {
    const [settled] = await this.database.query(
      `UPDATE connector_posts SET state = ?, updated_at = ?,
         body = CASE WHEN kind = 'status' THEN body ELSE '{}' END
       WHERE source = ? AND post_id = ? AND state = 'sending' AND next_at = ?`,
      [state, this.now(), this.source, post.postId, post.leaseUntil]
    )
    return Number(settled?.changes ?? 0) > 0
  }

  // Status rows stay while their thread may still be edited; a finished one-off post's id keeps a
  // retried reply or a repeated pause notice from posting twice until it goes.
  async pruneFinished(retentionMs: number): Promise<number> {
    const [result] = await this.database.query(
      `DELETE FROM connector_posts
       WHERE source = ? AND kind <> 'status'
         AND state IN ('posted', 'failed', 'uncertain', 'cancelled') AND updated_at < ?`,
      [this.source, this.now() - retentionMs]
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
    throw new Error('unknown post kind')
  }
  const body: unknown = JSON.parse(String(row.body))
  if (typeof body !== 'object' || body === null) {
    throw new Error('unreadable post body')
  }
  return {
    postId: String(row.post_id),
    workspaceId: String(row.workspace_id),
    containerId: String(row.container_id),
    threadId: String(row.thread_id),
    kind,
    body: Object.fromEntries(Object.entries(body)),
    rev: Number(row.rev),
    attempts: Number(row.attempts) + 1,
    messageRef: nullableText(row.message_ref),
    ...claim
  }
}
