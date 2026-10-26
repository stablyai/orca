import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import type { SlackInstalls } from './slack-installs.js'
import type { ClaimedPost, SlackPostKind, SlackPosts } from './slack-posts.js'
import type { SlackResult, SlackWebApi } from './slack-web-api.js'

const TextBodySchema = z.object({
  text: z.string().min(1),
  blocks: z.array(z.looseObject({ type: z.string() })).optional()
})
const ReactionBodySchema = z.object({ name: z.string().min(1), timestamp: z.string().min(1) })
const EphemeralBodySchema = z.object({
  text: z.string().min(1),
  user: z.string().min(1),
  // Present only when the message it answers was inside a thread.
  threadTs: z.string().min(1).optional()
})
const BODY_SCHEMAS: Record<SlackPostKind, z.ZodType> = {
  message: TextBodySchema,
  status: TextBodySchema,
  reaction: ReactionBodySchema,
  ephemeral: EphemeralBodySchema
}
const RepliesSchema = z.object({
  messages: z.array(
    z.looseObject({
      ts: z.string(),
      metadata: z.object({ event_payload: z.looseObject({ post_id: z.unknown() }) }).optional()
    })
  ),
  has_more: z.boolean().optional(),
  response_metadata: z.looseObject({ next_cursor: z.string().optional() }).optional()
})
const POST_METADATA_TYPE = 'orca_post'
// A post claimed back after a crash is looked for among replies sent from shortly before it, over
// a bounded number of pages; past that it can't be ruled out, so it is uncertain.
const RECONCILE_LOOKBACK_MS = 60_000
const RECONCILE_MAX_PAGES = 3

// Sends queued posts. A new message carries its post id in Slack metadata, so one that was left
// mid-send is looked for in the thread before it is sent again; if that check can't run, the post
// is marked uncertain rather than risking a duplicate.
export class SlackPostWorker {
  constructor(
    private readonly deps: {
      database: CloudDatabase
      posts: SlackPosts
      installs: SlackInstalls
      api: SlackWebApi
    }
  ) {}

  // Claimed heads are in different channels and go out in parallel, well inside their lease. A
  // database error leaves its post sending, so the lease brings it back to the history check.
  async sendDue(): Promise<void> {
    const claimed = await this.deps.posts.claim()
    const sent = await Promise.allSettled(claimed.map((post) => this.sendClaimed(post)))
    const failure = sent.find((result) => result.status === 'rejected')
    if (failure) {
      throw failure.reason
    }
  }

  // A post that can never go (no readable install token, an unreadable body) fails rather than
  // holding its channel.
  private async sendClaimed(post: ClaimedPost): Promise<void> {
    const token = await this.deps.installs.botToken(this.deps.database, post.teamId)
    const body = BODY_SCHEMAS[post.kind].safeParse(post.body)
    if (token === null || !body.success) {
      await this.deps.posts.settle(post, 'failed')
      return
    }
    await this.send(token, post)
  }

  private async send(token: string, post: ClaimedPost): Promise<void> {
    const { api, posts } = this.deps
    if (post.kind === 'reaction') {
      const body = ReactionBodySchema.parse(post.body)
      const result = await api(token, 'reactions.add', { channel: post.channelId, ...body })
      await this.finish(
        post,
        result.kind === 'failed' && result.error === 'already_reacted'
          ? { kind: 'ok', body: {} }
          : result,
        'retry'
      )
      return
    }
    if (post.kind === 'ephemeral') {
      // Nothing to look for afterwards, so an unclear outcome is retried; a duplicate is seen by
      // one person at most.
      const { text, user, threadTs } = EphemeralBodySchema.parse(post.body)
      const result = await api(token, 'chat.postEphemeral', {
        channel: post.channelId,
        user,
        text,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs })
      })
      if (result.kind === 'failed') {
        console.warn(
          JSON.stringify({ event: 'orca_connector_slack_ephemeral_failed', error: result.error })
        )
      }
      await this.finish(post, result, 'retry')
      return
    }
    const { text, blocks } = TextBodySchema.parse(post.body)
    if (post.kind === 'status' && post.slackTs !== null) {
      const result = await api(token, 'chat.update', {
        channel: post.channelId,
        ts: post.slackTs,
        text,
        ...(blocks ? { blocks } : {})
      })
      await this.finish(post, result, 'retry')
      return
    }
    if (post.stale) {
      const found = await this.findSent(token, post)
      if (found === undefined) {
        if (await posts.settle(post, 'uncertain')) {
          console.warn(JSON.stringify({ event: 'orca_connector_slack_post_uncertain' }))
        }
        return
      }
      if (found !== null) {
        await posts.found(post, found)
        return
      }
    }
    const result = await api(token, 'chat.postMessage', {
      channel: post.channelId,
      thread_ts: post.threadTs,
      text,
      ...(blocks ? { blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
      metadata: { event_type: POST_METADATA_TYPE, event_payload: { post_id: post.postId } }
    })
    // An unknown outcome stays sending; the lease brings it back to findSent.
    await this.finish(post, result, 'leave')
  }

  private async finish(
    post: ClaimedPost,
    result: SlackResult,
    onUnknown: 'retry' | 'leave'
  ): Promise<void> {
    const { posts } = this.deps
    switch (result.kind) {
      case 'ok': {
        const ts = typeof result.body.ts === 'string' ? result.body.ts : undefined
        await posts.posted(post, ts)
        return
      }
      case 'failed':
        await posts.settle(post, 'failed')
        return
      case 'retry':
        await posts.retry(post, result.afterMs)
        return
      case 'unknown':
        if (onUnknown === 'retry') {
          await posts.retry(post)
        }
    }
  }

  // The sent message's ts, null when it isn't in the thread, undefined when we couldn't tell.
  private async findSent(token: string, post: ClaimedPost): Promise<string | null | undefined> {
    let cursor: string | undefined
    for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
      const result = await this.deps.api(token, 'conversations.replies', {
        channel: post.channelId,
        ts: post.threadTs,
        oldest: String((post.sentAt - RECONCILE_LOOKBACK_MS) / 1000),
        include_all_metadata: true,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor })
      })
      const replies = result.kind === 'ok' ? RepliesSchema.safeParse(result.body) : undefined
      if (!replies?.success) {
        return undefined
      }
      const sent = replies.data.messages.find(
        (message) => message.metadata?.event_payload.post_id === post.postId
      )
      if (sent) {
        return sent.ts
      }
      // next_cursor is Slack's continuation; "more" without one can't be searched to the end.
      cursor = replies.data.response_metadata?.next_cursor || undefined
      if (cursor === undefined) {
        return replies.data.has_more ? undefined : null
      }
    }
    return undefined
  }
}
