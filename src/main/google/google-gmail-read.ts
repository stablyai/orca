// Gmail reads for `orca gmail search|read`: threads found with Gmail's own search syntax, and a
// thread or message as text, paged by character offset across its bodies. Mail is someone else's
// words; the CLI shows it fenced as content.
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import type {
  GmailAttachment,
  GmailMessageView,
  GmailReadView,
  GmailSearchView
} from '../../shared/google/google-read-types'
import { sliceAtCodeUnitLimit } from '../../shared/text/surrogate-safe-text-slice'
import {
  formatMegabytes,
  TOOL_DOWNLOAD_MAX_BYTES,
  TOOL_LIST_PAGE_SIZE,
  TOOL_TEXT_PAGE_CHARS
} from '../../shared/tool-output-limits'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import {
  attachmentsOf,
  bodyText,
  findPart,
  header,
  MessageSchema,
  sentAt,
  ThreadListSchema,
  ThreadSchema
} from './google-gmail-message'
import { parseGmailRef } from './google-gmail-ref'
import { htmlToText } from './google-html-text'

export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
// Gmail's per-user concurrency limit answers 429 well before 50 parallel reads.
export const GMAIL_CALLS_AT_ONCE = 10
const AttachmentSchema = lazyZodSchema(() =>
  z.object({ data: z.string(), size: z.number().optional() })
)

/** `work` over `items`, at most `limit` at a time, in order. */
export async function inBatches<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(work))))
  }
  return results
}

export async function searchGmail(
  api: GoogleApi,
  args: { query: string; pageToken?: string; limit?: number }
): Promise<GmailSearchView> {
  const url = new URL(`${GMAIL}/threads`)
  url.searchParams.set('q', args.query)
  url.searchParams.set('maxResults', String(Math.min(args.limit ?? TOOL_LIST_PAGE_SIZE, 50)))
  if (args.pageToken) {
    url.searchParams.set('pageToken', args.pageToken)
  }
  const list = await api.get('gmail', url.toString(), parseGoogleJson(ThreadListSchema))
  const threads = await inBatches(list.threads, GMAIL_CALLS_AT_ONCE, async ({ id }) => {
    const thread = new URL(`${GMAIL}/threads/${id}`)
    thread.searchParams.set('format', 'metadata')
    for (const name of ['From', 'Subject', 'Date']) {
      thread.searchParams.append('metadataHeaders', name)
    }
    return api.find('gmail', thread.toString(), parseGoogleJson(ThreadSchema))
  })
  return {
    account: api.email,
    ...(list.resultSizeEstimate !== undefined ? { estimate: list.resultSizeEstimate } : {}),
    ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}),
    threads: threads.flatMap((thread) => {
      const first = thread?.messages[0]
      const last = thread?.messages.at(-1)
      if (!thread || !first || !last) {
        return []
      }
      return [
        {
          ref: `gmail:thread:${thread.id}`,
          subject: header(first, 'Subject') ?? '',
          from: header(last, 'From') ?? '',
          at: sentAt(last),
          // Gmail's snippets keep HTML entities (&#39;).
          snippet: htmlToText(last.snippet ?? ''),
          messages: thread.messages.length,
          unread: thread.messages.some((message) => message.labelIds?.includes('UNREAD') ?? false)
        }
      ]
    })
  }
}

const MESSAGE_FRAMING_CHARS = 300
const ATTACHMENT_LINE_CHARS = 250
const MIN_FIRST_TEXT_CHARS = 2_000
const HEADER_MAX_CHARS = 2_000

function clipHeader(value: string | undefined): string {
  const text = value ?? ''
  return text.length > HEADER_MAX_CHARS ? `${text.slice(0, HEADER_MAX_CHARS)} (cut)` : text
}

/** A thread or message as text; `offset` pages through its bodies, oldest first. */
export async function readGmail(
  api: GoogleApi,
  args: { ref: string; offset?: number }
): Promise<GmailReadView> {
  const target = parseGmailRef(args.ref)
  const messages =
    target.kind === 'thread'
      ? (
          await api.get(
            'gmail',
            `${GMAIL}/threads/${target.id}?format=full`,
            parseGoogleJson(ThreadSchema)
          )
        ).messages
      : [
          await api.get(
            'gmail',
            `${GMAIL}/messages/${target.id}?format=full`,
            parseGoogleJson(MessageSchema)
          )
        ]
  const first = messages[0]
  const start = Math.max(0, args.offset ?? 0)
  let seen = 0
  let shown = 0
  let nextOffset: number | undefined
  const views: GmailMessageView[] = []
  for (const message of messages) {
    const body = bodyText(message.payload)
    const before = seen
    seen += body.length
    // Bodies an earlier page already showed are skipped; an empty one belongs to the first page past it.
    if (start > before && start >= seen) {
      continue
    }
    const from = Math.max(0, start - before)
    const who = {
      from: clipHeader(header(message, 'From')),
      to: clipHeader(header(message, 'To')),
      cc: clipHeader(header(message, 'Cc'))
    }
    const attachments = attachmentsOf(message)
    // Headers and attachment lines share the page, so the printed answer stays under the cap.
    const framing =
      MESSAGE_FRAMING_CHARS +
      who.from.length +
      who.to.length +
      who.cc.length +
      attachments.length * ATTACHMENT_LINE_CHARS
    const room = TOOL_TEXT_PAGE_CHARS - shown - framing
    if (nextOffset !== undefined || (views.length > 0 && room <= 0)) {
      nextOffset ??= before + from
      continue
    }
    // The first message on a page always shows some text, so --offset always moves on.
    const text = sliceAtCodeUnitLimit(body.slice(from), Math.max(room, MIN_FIRST_TEXT_CHARS))
    shown += text.length + framing
    if (from + text.length < body.length) {
      nextOffset = before + from + text.length
    }
    views.push({
      ref: `gmail:msg:${message.id}`,
      from: who.from,
      to: who.to,
      ...(who.cc ? { cc: who.cc } : {}),
      at: sentAt(message),
      body: text,
      ...(from > 0 || from + text.length < body.length
        ? { part: { from, to: from + text.length, of: body.length } }
        : {}),
      attachments
    })
  }
  return {
    account: api.email,
    ref: first ? `gmail:thread:${first.threadId}` : `gmail:${target.kind}:${target.id}`,
    subject: first ? (header(first, 'Subject') ?? '') : '',
    messages: views,
    ...(nextOffset !== undefined ? { nextOffset } : {})
  }
}

/** One attachment's bytes, found by its message and part (Gmail's own attachment ids change). */
export async function downloadGmailAttachment(
  api: GoogleApi,
  ref: string
): Promise<GmailAttachment & { data: string }> {
  const match = /^gmail:att:([A-Za-z0-9]+):([0-9.]+)$/.exec(ref.trim())
  if (!match?.[1] || !match[2]) {
    throw new GoogleToolError(
      'Name an attachment as `orca gmail read` lists it: gmail:att:<message>:<part>.'
    )
  }
  const [, messageId, partId] = match
  const message = await api.get(
    'gmail',
    `${GMAIL}/messages/${messageId}?format=full`,
    parseGoogleJson(MessageSchema)
  )
  const part = attachmentsOf(message).find((entry) => entry.ref === ref.trim())
  const body = findPart(message.payload, partId)?.body
  if (!part || !body) {
    throw new GoogleToolError('That message has no such attachment.')
  }
  if ((part.size ?? 0) > TOOL_DOWNLOAD_MAX_BYTES) {
    throw new GoogleToolError(
      `${part.name} is larger than ${formatMegabytes(TOOL_DOWNLOAD_MAX_BYTES)}, more than Orca hands an agent at once; open it in Gmail.`
    )
  }
  const data = body.attachmentId
    ? (
        await api.get(
          'gmail',
          `${GMAIL}/messages/${messageId}/attachments/${body.attachmentId}`,
          parseGoogleJson(AttachmentSchema)
        )
      ).data
    : (body.data ?? '')
  return { ...part, data: Buffer.from(data, 'base64url').toString('base64') }
}
