import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import type { ConnectorInbox } from './connector-inbox.js'
import { PERSON_SUBTYPES, promptText } from './slack-events.js'
import type { SlackInstalls } from './slack-installs.js'
import type { SlackMembers } from './slack-members.js'
import { slackText } from './slack-text.js'
import type { SlackWebApi } from './slack-web-api.js'

const STARTS_PER_PASS = 10
// Bounds on the thread a start carries: the first message plus the latest ones, each capped, read
// over at most a few pages; a longer thread starts with the "couldn't be read" note instead.
const THREAD_PAGE_SIZE = 200
const THREAD_MAX_PAGES = 5
const THREAD_MAX_MESSAGES = 20
const THREAD_MAX_MESSAGE_CHARS = 2_000

const HeldPayloadSchema = z.looseObject({ prompt: z.string() })

const RepliesSchema = z.object({
  messages: z.array(
    z.looseObject({
      ts: z.string(),
      user: z.string().optional(),
      bot_id: z.string().optional(),
      subtype: z.string().optional(),
      text: z.string().default('')
    })
  ),
  has_more: z.boolean().optional(),
  response_metadata: z.looseObject({ next_cursor: z.string().optional() }).optional()
})
type ThreadMessage = z.infer<typeof RepliesSchema>['messages'][number]

type HeldStart = {
  hostId: string
  deliveryId: string
  teamId: string
  channelId: string
  threadTs: string
  ts: string
  request: string
}

// Finishes starts for mentions partway through a thread (decisions §6: the request plus the thread
// start, labelled). Routing queues them held; this reads the thread off the request path and
// attaches it, and the inbox lets them go. Their follow-ups wait behind them in the inbox.
export class SlackThreadStarts {
  constructor(
    private readonly deps: {
      database: CloudDatabase
      inbox: ConnectorInbox
      installs: SlackInstalls
      members: SlackMembers
      api: SlackWebApi
      now: () => number
    }
  ) {}

  async buildDue(): Promise<void> {
    const { database, inbox } = this.deps
    const rows = await database.query(
      `SELECT i.host_id, i.delivery_id, i.payload, t.team_id, t.channel_id, t.thread_ts
       FROM connector_inbox i
       JOIN connector_threads t ON t.external_id = i.external_id AND t.host_id = i.host_id
       WHERE i.state = 'held' AND i.expires_at > ? ORDER BY i.expires_at LIMIT ?`,
      [this.deps.now(), STARTS_PER_PASS]
    )
    for (const row of rows) {
      const deliveryId = String(row.delivery_id)
      const start: HeldStart = {
        hostId: String(row.host_id),
        deliveryId,
        teamId: String(row.team_id),
        channelId: String(row.channel_id),
        threadTs: String(row.thread_ts),
        // Slack deliveries are keyed team:channel:ts.
        ts: deliveryId.slice(deliveryId.lastIndexOf(':') + 1),
        request: HeldPayloadSchema.parse(JSON.parse(String(row.payload))).prompt
      }
      const prompt = slackText.threadStart(await this.threadBefore(start), start.request)
      await database.transaction((transaction) =>
        inbox.attach(transaction, start.hostId, start.deliveryId, prompt)
      )
    }
  }

  // The thread's earlier messages from full members, labelled; null when Slack couldn't be read.
  private async threadBefore(start: HeldStart): Promise<{ name: string; text: string }[] | null> {
    const { database, installs, api } = this.deps
    const install = await installs.find(database, start.teamId)
    const token = await installs.botToken(database, start.teamId)
    if (!install || token === null) {
      return null
    }
    let first: ThreadMessage | undefined
    let latest: ThreadMessage[] = []
    let cursor: string | undefined
    for (let page = 0; page < THREAD_MAX_PAGES; page++) {
      const result = await api(token, 'conversations.replies', {
        channel: start.channelId,
        ts: start.threadTs,
        latest: start.ts,
        inclusive: false,
        limit: THREAD_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor })
      })
      const replies = result.kind === 'ok' ? RepliesSchema.safeParse(result.body) : undefined
      if (!replies?.success) {
        return null
      }
      const people = replies.data.messages.filter(
        (message) =>
          message.ts !== start.ts &&
          message.user !== undefined &&
          message.bot_id === undefined &&
          (message.subtype === undefined || PERSON_SUBTYPES.has(message.subtype))
      )
      first ??= people.shift()
      latest = [...latest, ...people].slice(-(THREAD_MAX_MESSAGES - 1))
      // next_cursor continues; "more" without one can't be read to the end.
      cursor = replies.data.response_metadata?.next_cursor || undefined
      if (cursor === undefined) {
        return replies.data.has_more
          ? null
          : await this.labelled(start.teamId, install.botUserId, first ? [first, ...latest] : [])
      }
    }
    return null
  }

  // Each kept message under its author's name; authors not confirmed full members are left out.
  private async labelled(
    teamId: string,
    botUserId: string,
    kept: ThreadMessage[]
  ): Promise<{ name: string; text: string }[]> {
    const names = await this.deps.members.memberNames(
      teamId,
      kept.flatMap((message) => message.user ?? [])
    )
    return kept.flatMap((message) => {
      const name = message.user === undefined ? undefined : names.get(message.user)
      const text = promptText(message.text, botUserId).slice(0, THREAD_MAX_MESSAGE_CHARS)
      return name === undefined || text.length === 0 ? [] : [{ name, text }]
    })
  }
}
