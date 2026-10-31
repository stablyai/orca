import { z } from 'zod'

const DISCORD_API_ORIGIN = 'https://discord.com/api/v10'
const DISCORD_API_TIMEOUT_MS = 10_000

export type DiscordResult =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'failed'; status: number; error: string }
  | { kind: 'retry'; afterMs?: number }
  // The request may or may not have reached Discord.
  | { kind: 'unknown' }

export type DiscordRoute = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
  path: string
  body?: Record<string, unknown>
  // Sent with the body as multipart; the body's attachments name them by index.
  files?: { name: string; text: string }[]
}

const MAX_CONTENT_CHARS = 2_000
const LONG_TEXT_FILE = 'message.txt'
const PREVIEW_CHARS = 1_900

// replyTo: answer that message, pinging only its writer; otherwise our text pings no one.
export type DiscordMessageBody = { content: string; components?: unknown[]; replyTo?: string }

function messageBody({ replyTo, ...message }: DiscordMessageBody): Record<string, unknown> {
  return replyTo === undefined
    ? { ...message, allowed_mentions: { parse: [] } }
    : {
        ...message,
        message_reference: { message_id: replyTo, fail_if_not_exists: false },
        allowed_mentions: { parse: [], replied_user: true }
      }
}

// https://docs.discord.com/developers/resources/message,
// https://docs.discord.com/developers/resources/channel
export const discordRoutes = {
  // The thread takes the message's id.
  startThread: (channelId: string, messageId: string, name: string): DiscordRoute => ({
    method: 'POST',
    path: `/channels/${channelId}/messages/${messageId}/threads`,
    body: { name }
  }),
  // Text over Discord's limit goes as a preview with the whole text attached.
  createMessage: (channelId: string, message: DiscordMessageBody): DiscordRoute => {
    const long = message.content.length > MAX_CONTENT_CHARS
    const body = messageBody(
      long
        ? {
            ...message,
            content: `${message.content.slice(0, PREVIEW_CHARS)}… (full text attached)`
          }
        : message
    )
    return long
      ? {
          method: 'POST',
          path: `/channels/${channelId}/messages`,
          body: { ...body, attachments: [{ id: 0, filename: LONG_TEXT_FILE }] },
          files: [{ name: LONG_TEXT_FILE, text: message.content }]
        }
      : { method: 'POST', path: `/channels/${channelId}/messages`, body }
  },
  editMessage: (
    channelId: string,
    messageId: string,
    message: DiscordMessageBody
  ): DiscordRoute => ({
    method: 'PATCH',
    path: `/channels/${channelId}/messages/${messageId}`,
    body: messageBody(message)
  }),
  // A unicode emoji, or a custom one as name:id; adding it twice is not an error.
  addReaction: (channelId: string, messageId: string, emoji: string): DiscordRoute => ({
    method: 'PUT',
    path: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
  }),
  currentUser: (): DiscordRoute => ({ method: 'GET', path: '/users/@me' }),
  channel: (channelId: string): DiscordRoute => ({ method: 'GET', path: `/channels/${channelId}` }),
  message: (channelId: string, messageId: string): DiscordRoute => ({
    method: 'GET',
    path: `/channels/${channelId}/messages/${messageId}`
  }),
  // Newest first.
  messagesBefore: (channelId: string, messageId: string, limit: number): DiscordRoute => ({
    method: 'GET',
    path: `/channels/${channelId}/messages?${new URLSearchParams({ before: messageId, limit: String(limit) })}`
  })
}

export type DiscordRestApi = (botToken: string, route: DiscordRoute) => Promise<DiscordResult>

const RateLimitedSchema = z.looseObject({ retry_after: z.number().nonnegative() })
const ErrorSchema = z.looseObject({ code: z.number().int() })

function requestBody(
  body: Record<string, unknown>,
  files: DiscordRoute['files']
): string | FormData {
  if (!files) {
    return JSON.stringify(body)
  }
  const form = new FormData()
  form.set('payload_json', JSON.stringify(body))
  files.forEach((file, index) => {
    form.set(`files[${index}]`, new Blob([file.text], { type: 'text/plain' }), file.name)
  })
  return form
}

function seconds(value: string | null): number | undefined {
  const parsed = Number(value)
  return value !== null && value !== '' && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined
}

// Plain HTTPS. The post queue sends one head per thread, so a 429 is retried after Discord's
// retry_after rather than tracked per bucket. A JSON array (message history) is returned as
// body.items.
export function createDiscordRestApi(
  request: typeof fetch = (input, init) => fetch(input, init)
): DiscordRestApi {
  return async (botToken, route) => {
    let response: Response
    try {
      response = await request(`${DISCORD_API_ORIGIN}${route.path}`, {
        method: route.method,
        headers: {
          authorization: `Bot ${botToken}`,
          ...(route.body === undefined || route.files ? {} : { 'content-type': 'application/json' })
        },
        ...(route.body === undefined ? {} : { body: requestBody(route.body, route.files) }),
        signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS)
      })
    } catch {
      return { kind: 'unknown' }
    }
    const body: unknown = response.status === 204 ? {} : await response.json().catch(() => null)
    if (response.status === 429) {
      const limited = RateLimitedSchema.safeParse(body)
      const afterSeconds = limited.success
        ? limited.data.retry_after
        : seconds(response.headers.get('retry-after'))
      return afterSeconds === undefined
        ? { kind: 'retry' }
        : { kind: 'retry', afterMs: afterSeconds * 1000 }
    }
    if (response.status >= 500) {
      return { kind: 'unknown' }
    }
    if (!response.ok) {
      // 401 and 403 count toward Discord's invalid-request ban, so they are never retried.
      if (response.status === 401 || response.status === 403) {
        console.warn(
          JSON.stringify({ event: 'orca_connector_discord_refused', status: response.status })
        )
      }
      const error = ErrorSchema.safeParse(body)
      return {
        kind: 'failed',
        status: response.status,
        error: error.success ? String(error.data.code) : `http_${response.status}`
      }
    }
    if (Array.isArray(body)) {
      return { kind: 'ok', body: { items: body } }
    }
    const parsed = z.looseObject({}).safeParse(body)
    return parsed.success ? { kind: 'ok', body: parsed.data } : { kind: 'unknown' }
  }
}
