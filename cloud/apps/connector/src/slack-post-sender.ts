import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import type { ClaimedPost, PostKind } from './connector-posts.js'
import type { SendOutcome } from './post-worker.js'
import type { SlackInstalls } from './slack-installs.js'
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
const BODY_SCHEMAS: Record<PostKind, z.ZodType> = {
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

// Sends one claimed post to Slack. A new message carries its post id in Slack metadata, so one that
// was left mid-send is looked for in the thread before it is sent again; if that check can't run,
// the post is uncertain rather than risking a duplicate.
export class SlackPostSender {
  constructor(
    private readonly deps: {
      database: CloudDatabase
      installs: SlackInstalls
      api: SlackWebApi
    }
  ) {}

  // A post that can never go (no readable install token, an unreadable body) fails rather than
  // holding its channel.
  async send(post: ClaimedPost): Promise<SendOutcome> {
    const token = await this.deps.installs.botToken(this.deps.database, post.workspaceId)
    const body = BODY_SCHEMAS[post.kind].safeParse(post.body)
    if (token === null || !body.success) {
      return { kind: 'failed' }
    }
    return await this.sendWith(token, post)
  }

  private async sendWith(token: string, post: ClaimedPost): Promise<SendOutcome> {
    const { api } = this.deps
    if (post.kind === 'reaction') {
      const body = ReactionBodySchema.parse(post.body)
      const result = await api(token, 'reactions.add', { channel: post.containerId, ...body })
      return outcome(
        result.kind === 'failed' && result.error === 'already_reacted'
          ? { kind: 'ok', body: {} }
          : result,
        'retry'
      )
    }
    if (post.kind === 'ephemeral') {
      // Nothing to look for afterwards, so an unclear outcome is retried; a duplicate is seen by
      // one person at most.
      const { text, user, threadTs } = EphemeralBodySchema.parse(post.body)
      const result = await api(token, 'chat.postEphemeral', {
        channel: post.containerId,
        user,
        text,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs })
      })
      if (result.kind === 'failed') {
        console.warn(
          JSON.stringify({ event: 'orca_connector_slack_ephemeral_failed', error: result.error })
        )
      }
      return outcome(result, 'retry')
    }
    const { text, blocks } = TextBodySchema.parse(post.body)
    if (post.kind === 'status' && post.messageRef !== null) {
      const result = await api(token, 'chat.update', {
        channel: post.containerId,
        ts: post.messageRef,
        text,
        ...(blocks ? { blocks } : {})
      })
      return outcome(result, 'retry')
    }
    if (post.stale) {
      const found = await this.findSent(token, post)
      if (found === undefined) {
        return { kind: 'uncertain' }
      }
      if (found !== null) {
        return { kind: 'found', messageRef: found }
      }
    }
    const result = await api(token, 'chat.postMessage', {
      channel: post.containerId,
      thread_ts: post.threadId,
      text,
      ...(blocks ? { blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
      metadata: { event_type: POST_METADATA_TYPE, event_payload: { post_id: post.postId } }
    })
    // An unknown outcome stays sending; the lease brings it back to findSent.
    return outcome(result, 'leave')
  }

  // The sent message's ts, null when it isn't in the thread, undefined when we couldn't tell.
  private async findSent(token: string, post: ClaimedPost): Promise<string | null | undefined> {
    let cursor: string | undefined
    for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
      const result = await this.deps.api(token, 'conversations.replies', {
        channel: post.containerId,
        ts: post.threadId,
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

function outcome(result: SlackResult, onUnknown: 'retry' | 'leave'): SendOutcome {
  switch (result.kind) {
    case 'ok':
      return {
        kind: 'posted',
        messageRef: typeof result.body.ts === 'string' ? result.body.ts : undefined
      }
    case 'failed':
      return { kind: 'failed' }
    case 'retry':
      return { kind: 'retry', afterMs: result.afterMs }
    case 'unknown':
      return onUnknown === 'retry' ? { kind: 'retry' } : { kind: 'unknown' }
  }
}
