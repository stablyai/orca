import { z } from 'zod'

const UrlVerificationSchema = z.object({
  type: z.literal('url_verification'),
  challenge: z.string()
})

const EventCallbackSchema = z.object({
  type: z.literal('event_callback'),
  team_id: z.string().min(1),
  // Slack Connect: a channel shared with another company.
  is_ext_shared_channel: z.boolean().optional(),
  event: z.looseObject({ type: z.string() })
})

const MessageEventSchema = z.object({
  type: z.enum(['message', 'app_mention']),
  subtype: z.string().optional(),
  user: z.string().min(1).optional(),
  bot_id: z.string().optional(),
  text: z.string().default(''),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  channel: z.string().min(1),
  channel_type: z.string().optional()
})

// Subtypes that are still a person's new message; edits, deletes and joins are not.
export const PERSON_SUBTYPES = new Set(['thread_broadcast', 'file_share'])

// One person's post, the same whether Slack sent it as message or app_mention.
export type SlackMessage = {
  teamId: string
  channelId: string
  userId: string
  ts: string
  threadTs: string
  text: string
  direct: boolean
}

export type SlackEnvelope =
  | { kind: 'url_verification'; challenge: string }
  | { kind: 'message'; message: SlackMessage }
  | { kind: 'ignored' }
  | { kind: 'invalid' }

export function readSlackEnvelope(payload: unknown): SlackEnvelope {
  const verification = UrlVerificationSchema.safeParse(payload)
  if (verification.success) {
    return { kind: 'url_verification', challenge: verification.data.challenge }
  }
  const callback = EventCallbackSchema.safeParse(payload)
  if (!callback.success) {
    return z.object({ type: z.string() }).safeParse(payload).success
      ? { kind: 'ignored' }
      : { kind: 'invalid' }
  }
  const event = MessageEventSchema.safeParse(callback.data.event)
  if (!event.success || callback.data.is_ext_shared_channel) {
    return { kind: 'ignored' }
  }
  const { subtype, user, bot_id: botId } = event.data
  if (!user || botId !== undefined || (subtype !== undefined && !PERSON_SUBTYPES.has(subtype))) {
    return { kind: 'ignored' }
  }
  return {
    kind: 'message',
    message: {
      teamId: callback.data.team_id,
      channelId: event.data.channel,
      userId: user,
      ts: event.data.ts,
      threadTs: event.data.thread_ts ?? event.data.ts,
      text: event.data.text,
      direct: event.data.channel_type === 'im' || event.data.channel.startsWith('D')
    }
  }
}

// Mentions may carry a label: <@U123> or <@U123|name>.
function mentionPattern(botUserId: string): RegExp {
  return new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g')
}

export function mentionsBot(text: string, botUserId: string): boolean {
  return mentionPattern(botUserId).test(text)
}

// What the agent reads: the mention dropped and Slack's three escapes undone.
export function promptText(text: string, botUserId: string): string {
  return text
    .replace(mentionPattern(botUserId), '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .trim()
}
