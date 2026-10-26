import type { CloudDatabase } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_PATHS,
  ConnectorReplyRequestSchema,
  type ConnectorEvent,
  type ConnectorReplyResponse
} from '@orca-cloud/connector-contract'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { every } from './connector-background.js'
import type { ConnectorInbox, ExpiredThread } from './connector-inbox.js'
import { isStored } from './connector-threads.js'
import type { MachineEnv } from './machine-auth.js'
import type { SlackConfig } from './slack-config.js'
import { readSlackEnvelope } from './slack-events.js'
import { SlackInstalls } from './slack-installs.js'
import { SlackMembers } from './slack-members.js'
import { SlackPostWorker } from './slack-post-worker.js'
import { handleSlackClick, readSlackClick } from './slack-clicks.js'
import { SlackPosts } from './slack-posts.js'
import type { QueueInTransaction } from './queue-delivery.js'
import { routeSlackMessage } from './slack-routing.js'
import { verifySlackSignature } from './slack-signature.js'
import { SlackThreadStarts } from './slack-thread-start.js'
import { queueAgentReply, queueTurnFallback, refreshSlackStatus } from './slack-thread-posts.js'
import { createSlackWebApi, type SlackWebApi } from './slack-web-api.js'

// Slack's payloads can carry blocks and files well past the machine API's limit.
const MAX_SLACK_BODY_BYTES = 1024 * 1024
const POST_INTERVAL_MS = 1_000
const MEMBER_CHECK_INTERVAL_MS = 5_000
const RETENTION_INTERVAL_MS = 60_000
const SEEN_RETENTION_MS = 7 * 24 * 60 * 60_000
const CONTEXT_RETENTION_MS = 24 * 60 * 60_000
// As long as Slack's own retries and the inbox's settled rows: a post id that outlives them keeps
// a retried reply from posting twice.
const POST_RETENTION_MS = 7 * 24 * 60 * 60_000

export type SlackEdge = ReturnType<typeof createSlackEdge>

// Slack in and out: event ingress, starts that carry their thread, the agent's replies, and the post
// queue that turns thread state into a reaction, one edited status message (offline included), the
// fallback posts and replies only the writer sees.
export function createSlackEdge(deps: {
  config: SlackConfig
  database: CloudDatabase
  inbox: ConnectorInbox
  queue: QueueInTransaction
  now: () => number
  api?: SlackWebApi
}) {
  const { config, database, now } = deps
  const installs = new SlackInstalls(config.tokenKey)
  const posts = new SlackPosts(database, now)
  const api = deps.api ?? createSlackWebApi()
  const worker = new SlackPostWorker({ database, posts, installs, api })
  const members = new SlackMembers({ database, installs, api, now })
  const starts = new SlackThreadStarts({ database, inbox: deps.inbox, installs, members, api, now })
  const refresh = async (
    transaction: CloudDatabase,
    hostId: string,
    externalIds: Iterable<string>
  ) => {
    for (const externalId of new Set(externalIds)) {
      await refreshSlackStatus(transaction, posts, hostId, externalId)
    }
  }

  // Slack's own requests: signed over the raw body, size-capped.
  const fromSlack = (
    app: Hono<MachineEnv>,
    path: string,
    handle: (context: Context<MachineEnv>, rawBody: string) => Promise<Response>
  ) =>
    app.post(
      path,
      bodyLimit({
        maxSize: MAX_SLACK_BODY_BYTES,
        onError: (context) => context.json({ error: 'request_too_large' }, 413)
      }),
      async (context) => {
        const rawBody = await context.req.text()
        const verified = verifySlackSignature({
          signingSecret: config.signingSecret,
          timestamp: context.req.header('x-slack-request-timestamp'),
          signature: context.req.header('x-slack-signature'),
          rawBody,
          nowMs: now()
        })
        return verified
          ? await handle(context, rawBody)
          : context.json({ error: 'invalid_signature' }, 401)
      }
    )

  function registerRoutes(app: Hono<MachineEnv>, limitMachineBody: MiddlewareHandler): void {
    fromSlack(app, '/slack/events', async (context, rawBody) => {
      let payload: unknown
      try {
        payload = JSON.parse(rawBody)
      } catch {
        return context.json({ error: 'invalid_request' }, 400)
      }
      const envelope = readSlackEnvelope(payload)
      if (envelope.kind === 'invalid') {
        return context.json({ error: 'invalid_request' }, 400)
      }
      if (envelope.kind === 'url_verification') {
        return context.json({ challenge: envelope.challenge })
      }
      // Answered before any Slack call; a database failure is a 500, so Slack retries.
      if (envelope.kind === 'message' && config.teamIds.has(envelope.message.teamId)) {
        await routeSlackMessage(
          { config, database, installs, posts, queue: deps.queue, now },
          envelope.message
        )
      }
      return context.body(null, 200)
    })

    // Answer presses on prompt cards; answered before any Slack call, like events.
    fromSlack(app, '/slack/interactivity', async (context, rawBody) => {
      const click = readSlackClick(rawBody)
      if (click === 'invalid') {
        return context.json({ error: 'invalid_request' }, 400)
      }
      if (click !== 'ignored' && config.teamIds.has(click.teamId)) {
        await handleSlackClick({ config, database, installs, posts, queue: deps.queue }, click)
      }
      return context.body(null, 200)
    })

    app.post(CONNECTOR_PATHS.replies, limitMachineBody, async (context) => {
      const body = ConnectorReplyRequestSchema.safeParse(await context.req.json().catch(() => null))
      if (!body.success) {
        return context.json({ error: 'invalid_request' }, 400)
      }
      const { hostId } = context.get('host')
      const { replyId, conversation, turnId, text } = body.data
      if (!isStored(conversation)) {
        return context.json({ error: 'not_this_hosts_thread' }, 403)
      }
      const sent = await database.transaction((transaction) =>
        queueAgentReply(transaction, posts, hostId, {
          replyId,
          externalId: conversation.externalId,
          turnId,
          text
        })
      )
      if (!sent) {
        return context.json({ error: 'not_this_hosts_thread' }, 403)
      }
      const response: ConnectorReplyResponse =
        sent.state === 'posted' && sent.slackTs !== null
          ? { status: 'posted', messageId: sent.slackTs }
          : { status: 'queued' }
      return context.json(response)
    })
  }

  return {
    registerRoutes,
    worker,
    members,
    starts,
    // In the transaction that applied a machine's events batch; posts go out on the next pass.
    onEvents: async (transaction: CloudDatabase, hostId: string, events: ConnectorEvent[]) => {
      const externalIds = events.flatMap((event) =>
        event.kind === 'snapshot'
          ? event.conversations.map((entry) => entry.conversation.externalId)
          : [event.conversation.externalId]
      )
      // A snapshot also changes the threads it doesn't list (unverifiable turn, no prompt).
      const unlisted = events.some((event) => event.kind === 'snapshot')
        ? await transaction.query('SELECT external_id FROM connector_threads WHERE host_id = ?', [
            hostId
          ])
        : []
      await refresh(transaction, hostId, [
        ...externalIds,
        ...unlisted.map((row) => String(row.external_id))
      ])
      for (const event of events) {
        if (event.kind === 'turn-ended' && event.lastAssistantMessage !== undefined) {
          await queueTurnFallback(transaction, posts, hostId, {
            externalId: event.conversation.externalId,
            turnId: event.turnId,
            lastAssistantMessage: event.lastAssistantMessage
          })
        }
      }
    },
    // In the transaction that recorded a machine's confirmations.
    onAcks: async (transaction: CloudDatabase, hostId: string, deliveryIds: string[]) => {
      const rows = await transaction.query(
        `SELECT DISTINCT external_id FROM connector_inbox
         WHERE host_id = ? AND delivery_id IN (${deliveryIds.map(() => '?').join(', ')})`,
        [hostId, ...deliveryIds]
      )
      await refresh(
        transaction,
        hostId,
        rows.map((row) => String(row.external_id))
      )
    },
    // In the expiry sweep's transaction, with the threads it hit.
    onExpired: async (transaction: CloudDatabase, threads: ExpiredThread[]) => {
      for (const { hostId, externalId } of threads) {
        await refreshSlackStatus(transaction, posts, hostId, externalId)
      }
    },
    startBackground: (): (() => void) => {
      const stops = [
        every('slack_posts', POST_INTERVAL_MS, () => worker.sendDue()),
        every('slack_thread_starts', POST_INTERVAL_MS, () => starts.buildDue()),
        every('slack_members', MEMBER_CHECK_INTERVAL_MS, () => members.checkContextAuthors()),
        every('slack_retention', RETENTION_INTERVAL_MS, async () => {
          await database.query('DELETE FROM connector_slack_seen WHERE seen_at < ?', [
            now() - SEEN_RETENTION_MS
          ])
          await database.query('DELETE FROM connector_thread_context WHERE created_at < ?', [
            now() - CONTEXT_RETENTION_MS
          ])
          await posts.pruneFinished(POST_RETENTION_MS)
        })
      ]
      return () => {
        for (const stop of stops) {
          stop()
        }
      }
    }
  }
}
