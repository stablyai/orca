// What a Gmail draft says before it is saved: a new message, a reply that stays in its thread, a
// forward with the original's files, or a revision that keeps what it isn't given.
import type { GmailDraftView } from '../../shared/google/google-write-types'
import { formatMegabytes, TOOL_DOWNLOAD_MAX_BYTES } from '../../shared/tool-output-limits'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import {
  attachmentsOf,
  bodyText,
  header,
  MessageSchema,
  ThreadSchema,
  type Message
} from './google-gmail-message'
import { downloadGmailAttachment, GMAIL, parseGmailRef } from './google-gmail-read'
import { addressOf, type MimeAttachment, type MimeDraft } from './gmail-mime-message'
import { splitAddresses } from '../../shared/google/email-address-list'

export type GmailDraftArgs = {
  to: string[]
  cc: string[]
  bcc: string[]
  subject?: string
  body?: string
  replyTo?: string
  replyAll?: boolean
  forward?: string
  draft?: string
  attachments: { name: string; data: string }[]
}

/** The message a reply or forward is about: the one named, or a thread's latest. */
async function originalMessage(api: GoogleApi, ref: string): Promise<Message> {
  const target = parseGmailRef(ref)
  if (target.kind === 'msg') {
    return api.get(
      'gmail',
      `${GMAIL}/messages/${target.id}?format=full`,
      parseGoogleJson(MessageSchema)
    )
  }
  const thread = await api.get(
    'gmail',
    `${GMAIL}/threads/${target.id}?format=full`,
    parseGoogleJson(ThreadSchema)
  )
  const latest = thread.messages.findLast((message) => !message.labelIds?.includes('DRAFT'))
  if (!latest) {
    throw new GoogleToolError('That thread has no message to answer.')
  }
  return latest
}

function quoted(message: Message): string {
  const said = bodyText(message.payload)
  const when = header(message, 'Date') ?? ''
  const who = header(message, 'From') ?? ''
  return [
    `On ${when}, ${who} wrote:`,
    ...said.split('\n').map((line) => (line ? `> ${line}` : '>'))
  ].join('\n')
}

function forwarded(message: Message): string {
  return [
    '---------- Forwarded message ---------',
    `From: ${header(message, 'From') ?? ''}`,
    `Date: ${header(message, 'Date') ?? ''}`,
    `Subject: ${header(message, 'Subject') ?? ''}`,
    `To: ${header(message, 'To') ?? ''}`,
    ...(header(message, 'Cc') ? [`Cc: ${header(message, 'Cc')}`] : []),
    '',
    bodyText(message.payload)
  ].join('\n')
}

const withPrefix = (prefix: RegExp, add: string, subject: string) =>
  prefix.test(subject) ? subject : `${add}${subject}`

/** Recipients without repeats or the account itself, in the order given. */
function people(entries: string[], except: Set<string>): string[] {
  const seen = new Set(except)
  return entries.filter((entry) => {
    const email = addressOf(entry)
    if (seen.has(email)) {
      return false
    }
    seen.add(email)
    return true
  })
}

async function savedAttachments(api: GoogleApi, message: Message): Promise<MimeAttachment[]> {
  const files = attachmentsOf(message)
  const total = files.reduce((sum, file) => sum + (file.size ?? 0), 0)
  if (total > TOOL_DOWNLOAD_MAX_BYTES) {
    throw new GoogleToolError(
      `Its attachments are over ${formatMegabytes(TOOL_DOWNLOAD_MAX_BYTES)} together; forward it from Gmail.`
    )
  }
  return Promise.all(
    files.map(async (file) => {
      const got = await downloadGmailAttachment(api, file.ref)
      return {
        name: got.name,
        ...(got.type ? { type: got.type } : {}),
        data: Buffer.from(got.data, 'base64')
      }
    })
  )
}

export type Composed = { mime: MimeDraft; threadId?: string; kind: GmailDraftView['kind'] }

export async function composeReply(api: GoogleApi, args: GmailDraftArgs): Promise<Composed> {
  const original = await originalMessage(api, args.replyTo ?? '')
  const me = api.email.toLowerCase()
  const sender = header(original, 'Reply-To') ?? header(original, 'From') ?? ''
  // Answering your own message goes back to the people it went to.
  const fromMe = addressOf(header(original, 'From') ?? '') === me
  const replyTo = fromMe ? splitAddresses(header(original, 'To')) : splitAddresses(sender)
  const everyone = args.replyAll
    ? [
        ...(fromMe ? [] : splitAddresses(header(original, 'To'))),
        ...splitAddresses(header(original, 'Cc'))
      ]
    : []
  const subject = withPrefix(/^re:/i, 'Re: ', header(original, 'Subject') ?? '')
  if (args.subject !== undefined && args.subject.trim() !== subject) {
    throw new GoogleToolError(
      `A reply keeps the subject "${subject}" so it stays in its thread; drop --subject, or start a new draft without --reply-to.`
    )
  }
  const to = people([...replyTo, ...args.to], new Set([me]))
  const messageId = header(original, 'Message-ID')
  return {
    kind: 'reply',
    threadId: original.threadId,
    mime: {
      to,
      cc: people([...everyone, ...args.cc], new Set([me, ...to.map(addressOf)])),
      bcc: args.bcc,
      subject,
      body: [args.body ?? '', '', quoted(original)].join('\n'),
      ...(messageId
        ? {
            inReplyTo: messageId,
            references: [header(original, 'References'), messageId].filter(Boolean).join(' ')
          }
        : {}),
      attachments: []
    }
  }
}

export async function composeForward(api: GoogleApi, args: GmailDraftArgs): Promise<Composed> {
  if (args.to.length === 0) {
    throw new GoogleToolError('Say who to forward it to with --to.')
  }
  const original = await originalMessage(api, args.forward ?? '')
  return {
    kind: 'forward',
    mime: {
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject ?? withPrefix(/^fwd?:/i, 'Fwd: ', header(original, 'Subject') ?? ''),
      body: [args.body ?? '', '', forwarded(original)].join('\n'),
      attachments: await savedAttachments(api, original)
    }
  }
}

/** A revision keeps the draft's recipients, subject, thread, body and files unless given new ones. */
export async function composeRevision(
  api: GoogleApi,
  args: GmailDraftArgs,
  existing: Message
): Promise<Composed> {
  const references = header(existing, 'References')
  const inReplyTo = header(existing, 'In-Reply-To')
  return {
    kind: inReplyTo ? 'reply' : 'new',
    threadId: existing.threadId,
    mime: {
      to: args.to.length > 0 ? args.to : splitAddresses(header(existing, 'To')),
      cc: args.cc.length > 0 ? args.cc : splitAddresses(header(existing, 'Cc')),
      bcc: args.bcc.length > 0 ? args.bcc : splitAddresses(header(existing, 'Bcc')),
      subject: args.subject ?? header(existing, 'Subject') ?? '',
      body: args.body ?? bodyText(existing.payload),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {}),
      attachments: await savedAttachments(api, existing)
    }
  }
}

export function composeNew(args: GmailDraftArgs): Composed {
  if (args.to.length === 0) {
    throw new GoogleToolError('Say who it is to with --to.')
  }
  if (!args.subject?.trim()) {
    throw new GoogleToolError('Give it a --subject.')
  }
  return {
    kind: 'new',
    mime: {
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      body: args.body ?? '',
      attachments: []
    }
  }
}
