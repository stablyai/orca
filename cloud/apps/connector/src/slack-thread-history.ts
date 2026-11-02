import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import type { ThreadPlace } from './connector-adapter.js'
import { PERSON_SUBTYPES, promptText } from './slack-events.js'
import type { SlackInstalls } from './slack-installs.js'
import type { SlackMembers } from './slack-members.js'
import { slackText } from './slack-text.js'
import type { SlackWebApi } from './slack-web-api.js'

// Bounds on the thread a start carries: the first message plus the latest ones, each capped, read
// over at most a few pages; a longer thread starts with the "couldn't be read" note instead.
const THREAD_PAGE_SIZE = 200
const THREAD_MAX_PAGES = 5
const THREAD_MAX_MESSAGES = 20
const THREAD_MAX_MESSAGE_CHARS = 2_000

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

type HeldStart = { place: ThreadPlace; messageId: string; request: string }

// A held start's prompt for a mention partway through a Slack thread: the request plus the thread
// before it from full members, labelled.
export class SlackThreadHistory {
  constructor(
    private readonly deps: {
      database: CloudDatabase
      installs: SlackInstalls
      members: SlackMembers
      api: SlackWebApi
    }
  ) {}

  async heldStartPrompt(start: HeldStart): Promise<string> {
    return slackText.threadStart(await this.threadBefore(start), start.request)
  }

  // The thread's earlier messages from full members, labelled; null when Slack couldn't be read.
  private async threadBefore(start: HeldStart): Promise<{ name: string; text: string }[] | null> {
    const { database, installs, api } = this.deps
    const { workspaceId: teamId, containerId: channel, threadId } = start.place
    const install = await installs.find(database, teamId)
    const token = await installs.botToken(database, teamId)
    if (!install || token === null) {
      return null
    }
    let first: ThreadMessage | undefined
    let latest: ThreadMessage[] = []
    let cursor: string | undefined
    for (let page = 0; page < THREAD_MAX_PAGES; page++) {
      const result = await api(token, 'conversations.replies', {
        channel,
        ts: threadId,
        latest: start.messageId,
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
          message.ts !== start.messageId &&
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
          : await this.labelled(teamId, install.botUserId, first ? [first, ...latest] : [])
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
