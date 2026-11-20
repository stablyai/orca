// New mail since the last check, from Gmail's change history: a stored historyId moves forward each
// check. When Gmail no longer has that point (history expired, about a week but sometimes hours), the
// checker starts again from now and fires nothing old.
import { z } from 'zod'
import { mailboxAddress, splitAddresses } from '../../shared/google/email-address-list'
import { parseGoogleJson, type GoogleApi } from './google-api-client'
import { header, MessageSchema, sentAt, type Message } from './google-gmail-message'
import { inBatches } from './google-gmail-read'
import { htmlToText } from './google-html-text'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
// A check reads at most this many new messages; a flood past it is skipped, never queued.
export const MAX_NEW_MAIL_PER_CHECK = 50
const MAX_HISTORY_PAGES = 5
const MESSAGE_READS_AT_ONCE = 10
// Mail no rule should ever start on: the owner's own, unsent, junk or deleted.
const IGNORED_LABELS = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT'])

const ProfileSchema = z.object({ historyId: z.string() })
const HistorySchema = z.object({
  historyId: z.string(),
  nextPageToken: z.string().optional(),
  history: z
    .array(
      z.object({
        messagesAdded: z
          .array(
            z.object({
              message: z.object({
                id: z.string(),
                threadId: z.string(),
                labelIds: z.array(z.string()).optional()
              })
            })
          )
          .optional()
      })
    )
    .default([])
})
const LabelsSchema = z.object({
  labels: z.array(z.object({ id: z.string(), name: z.string() })).default([])
})

export type NewMail = {
  id: string
  threadId: string
  labelIds: string[]
  from: string
  to: string
  cc: string
  subject: string
  snippet: string
  at: number
  /** Gmail's own domain check passed for the From address's domain. */
  senderVerified: boolean
}

export type GmailChanges =
  | { kind: 'seeded'; historyId: string }
  | { kind: 'changes'; historyId: string; mail: NewMail[]; skipped: number }

/** Where history starts now: the mailbox's current point. */
export async function gmailHistoryNow(api: GoogleApi): Promise<string> {
  return (await api.get('gmail', `${GMAIL}/profile`, parseGoogleJson(ProfileSchema))).historyId
}

/** Mail added since `historyId`, oldest first; re-seeded (and nothing fired) when Gmail lost the point. */
export async function gmailChangesSince(api: GoogleApi, historyId: string): Promise<GmailChanges> {
  const added = new Map<string, { id: string; labelIds: string[] }>()
  let latest = historyId
  let pageToken: string | undefined
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const url = new URL(`${GMAIL}/history`)
    url.searchParams.set('startHistoryId', historyId)
    url.searchParams.set('historyTypes', 'messageAdded')
    url.searchParams.set('maxResults', '500')
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }
    const answer = await api.find('gmail', url.toString(), parseGoogleJson(HistorySchema))
    if (!answer) {
      return { kind: 'seeded', historyId: await gmailHistoryNow(api) }
    }
    latest = answer.historyId
    for (const entry of answer.history) {
      for (const { message } of entry.messagesAdded ?? []) {
        added.set(message.id, { id: message.id, labelIds: message.labelIds ?? [] })
      }
    }
    pageToken = answer.nextPageToken
    if (!pageToken) {
      break
    }
  }
  const wanted = [...added.values()].filter(
    (entry) => !entry.labelIds.some((label) => IGNORED_LABELS.has(label))
  )
  const kept = wanted.slice(-MAX_NEW_MAIL_PER_CHECK)
  const read = await inBatches(kept, MESSAGE_READS_AT_ONCE, async ({ id }) => {
    const url = new URL(`${GMAIL}/messages/${id}`)
    url.searchParams.set('format', 'metadata')
    for (const name of ['From', 'To', 'Cc', 'Subject', 'Authentication-Results']) {
      url.searchParams.append('metadataHeaders', name)
    }
    // A message deleted since it arrived is gone, not an error.
    return api.find('gmail', url.toString(), parseGoogleJson(MessageSchema))
  })
  const mail = read
    .flatMap((message) => (message ? [newMailOf(message)] : []))
    .filter((entry) => !entry.labelIds.some((label) => IGNORED_LABELS.has(label)))
    .sort((a, b) => a.at - b.at)
  return {
    kind: 'changes',
    historyId: latest,
    mail,
    skipped: wanted.length - kept.length
  }
}

/** Label names (lowercased) to ids, for rules that name a label. */
export async function gmailLabelIds(api: GoogleApi): Promise<Map<string, string>> {
  const { labels } = await api.get('gmail', `${GMAIL}/labels`, parseGoogleJson(LabelsSchema))
  return new Map(labels.map((label) => [label.name.toLowerCase(), label.id]))
}

function newMailOf(message: Message): NewMail {
  const from = header(message, 'From') ?? ''
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? [],
    from,
    to: header(message, 'To') ?? '',
    cc: header(message, 'Cc') ?? '',
    subject: header(message, 'Subject') ?? '',
    snippet: htmlToText(message.snippet ?? ''),
    at: sentAt(message),
    senderVerified: senderVerified(message, from)
  }
}

/** The one real From address, or none when the header names several or none. */
export function senderAddress(from: string): string | undefined {
  const mailboxes = splitAddresses(from)
  return (mailboxes.length === 1 && mailboxAddress(mailboxes[0])) || undefined
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1)

// Gmail stamps its own check on top as `Authentication-Results: mx.google.com; ... dmarc=pass ...
// header.from=acme.com`. A sender can add look-alikes below it, so only the topmost one counts.
function senderVerified(message: Message, from: string): boolean {
  const address = senderAddress(from)
  if (!address) {
    return false
  }
  const domain = domainOf(address)
  return (message.payload?.headers ?? [])
    .filter((entry) => entry.name.toLowerCase() === 'authentication-results')
    .slice(0, 1)
    .map((entry) => entry.value.toLowerCase())
    .some(
      (value) =>
        value.trimStart().startsWith('mx.google.com;') &&
        /\bdmarc=pass\b/.test(value) &&
        new RegExp(`\\bheader\\.from=${escapeRegExp(domain)}(?![\\w.-])`).test(value)
    )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
