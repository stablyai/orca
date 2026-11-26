// Gmail writes for `orca gmail draft|send|archive|label|mark-read`. Mail is drafted first and sent
// as its own step; a reply stays in its thread, and a revised draft keeps what it doesn't change.
import { z } from 'zod'
import type {
  GmailDraftView,
  GmailModifyView,
  GmailSendView
} from '../../shared/google/google-write-types'
import { formatMegabytes, TOOL_DOWNLOAD_MAX_BYTES } from '../../shared/tool-output-limits'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import {
  composeForward,
  composeNew,
  composeReply,
  composeRevision,
  type GmailDraftArgs
} from './google-gmail-draft-compose'
import { header, MessageSchema } from './google-gmail-message'
import { GMAIL, GMAIL_CALLS_AT_ONCE, inBatches } from './google-gmail-read'
import { parseGmailRef } from './google-gmail-ref'
import { randomBytes } from 'node:crypto'
import { splitAddresses } from '../../shared/google/email-address-list'
import { buildMimeMessage } from './gmail-mime-message'

export type { GmailDraftArgs }

const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me'

const DraftSchema = z.object({ id: z.string(), message: MessageSchema })
const SentSchema = z.object({ id: z.string(), threadId: z.string() })
const LabelSchema = z.object({ id: z.string(), name: z.string(), type: z.string().optional() })
const LabelsSchema = z.object({ labels: z.array(LabelSchema).default([]) })

/** `gmail:draft:<id>` as draft prints it, or a bare draft id. */
export function parseDraftRef(ref: string): string {
  const trimmed = ref.trim()
  const id = /^gmail:draft:([A-Za-z0-9_-]+)$/.exec(trimmed)?.[1] ?? trimmed
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new GoogleToolError(
      `"${trimmed.slice(0, 80)}" isn't a draft id. Use the gmail:draft:… ref \`orca gmail draft\` prints.`
    )
  }
  return id
}

function multipartUpload(metadata: unknown, raw: string): { body: string; contentType: string } {
  const boundary = `orca-${randomBytes(12).toString('hex')}`
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    body: [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: message/rfc822',
      '',
      raw,
      `--${boundary}--`,
      ''
    ].join('\r\n')
  }
}

const draftLink = (email: string, messageId: string) =>
  `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#drafts?compose=${messageId}`

/** Saves a new draft, or revises one with --draft; never sends. */
export async function saveGmailDraft(
  api: GoogleApi,
  args: GmailDraftArgs
): Promise<GmailDraftView> {
  if (args.replyTo && args.forward) {
    throw new GoogleToolError('Pick one: --reply-to answers a message, --forward passes it on.')
  }
  if (args.replyAll && !args.replyTo) {
    throw new GoogleToolError('--reply-all goes with --reply-to <message>.')
  }
  const draftId = args.draft === undefined ? undefined : parseDraftRef(args.draft)
  if (draftId && (args.replyTo || args.forward)) {
    throw new GoogleToolError(
      'A draft keeps what it answers or forwards; pass --draft with only the changes.'
    )
  }
  const existing = draftId
    ? await api.find(
        'gmail',
        `${GMAIL}/drafts/${draftId}?format=full`,
        parseGoogleJson(DraftSchema)
      )
    : null
  if (draftId && !existing) {
    throw new GoogleToolError(
      'That draft is gone: it was sent or deleted. Start a new one without --draft.'
    )
  }
  const composed = existing
    ? await composeRevision(api, args, existing.message)
    : args.replyTo
      ? await composeReply(api, args)
      : args.forward
        ? await composeForward(api, args)
        : composeNew(args)
  const attachments = [
    ...composed.mime.attachments,
    ...args.attachments.map((file) => ({ name: file.name, data: Buffer.from(file.data, 'base64') }))
  ]
  const bytes = attachments.reduce((sum, file) => sum + file.data.length, 0)
  if (bytes > TOOL_DOWNLOAD_MAX_BYTES) {
    throw new GoogleToolError(
      `Attachments come to ${formatMegabytes(bytes)}; a draft from Orca takes up to ${formatMegabytes(TOOL_DOWNLOAD_MAX_BYTES)}. Share a Drive link instead.`
    )
  }
  const mime = { ...composed.mime, attachments }
  const metadata = {
    ...(draftId ? { id: draftId } : {}),
    message: composed.threadId ? { threadId: composed.threadId } : {}
  }
  const upload = multipartUpload(metadata, buildMimeMessage(mime))
  const saved = await api.send(
    'gmail',
    {
      method: draftId ? 'PUT' : 'POST',
      url: `${UPLOAD}/drafts${draftId ? `/${draftId}` : ''}?uploadType=multipart`,
      raw: upload
    },
    parseGoogleJson(DraftSchema)
  )
  return {
    account: api.email,
    ref: `gmail:draft:${saved.id}`,
    messageRef: `gmail:msg:${saved.message.id}`,
    threadRef: `gmail:thread:${saved.message.threadId}`,
    to: mime.to,
    cc: mime.cc,
    bcc: mime.bcc,
    subject: mime.subject,
    kind: composed.kind,
    updated: draftId !== undefined,
    attachments: attachments.map((file) => file.name),
    link: draftLink(api.email, saved.message.id)
  }
}

/** Sends a saved draft as it is. */
export async function sendGmailDraft(api: GoogleApi, ref: string): Promise<GmailSendView> {
  const id = parseDraftRef(ref)
  const draft = await api.find(
    'gmail',
    `${GMAIL}/drafts/${id}?format=metadata`,
    parseGoogleJson(DraftSchema)
  )
  if (!draft) {
    throw new GoogleToolError(
      'That draft is gone: it was already sent or deleted. `orca gmail search "in:sent"` shows what went out.'
    )
  }
  const to = splitAddresses(header(draft.message, 'To'))
  const cc = splitAddresses(header(draft.message, 'Cc'))
  const bcc = splitAddresses(header(draft.message, 'Bcc'))
  if (to.length + cc.length + bcc.length === 0) {
    throw new GoogleToolError(
      'That draft has no recipients. Add them with `orca gmail draft --draft <ref> --to …`.'
    )
  }
  const sent = await api.send(
    'gmail',
    { method: 'POST', url: `${GMAIL}/drafts/send`, json: { id } },
    parseGoogleJson(SentSchema)
  )
  return {
    account: api.email,
    messageRef: `gmail:msg:${sent.id}`,
    threadRef: `gmail:thread:${sent.threadId}`,
    to,
    cc,
    bcc,
    subject: header(draft.message, 'Subject') ?? ''
  }
}

// Gmail's own labels, by the names people use for them.
const SYSTEM_LABELS: Record<string, string> = {
  inbox: 'INBOX',
  unread: 'UNREAD',
  starred: 'STARRED',
  important: 'IMPORTANT'
}

async function labelIds(
  api: GoogleApi,
  names: string[],
  create: boolean
): Promise<{ ids: string[]; created: string[] }> {
  if (names.some((name) => ['trash', 'spam'].includes(name.trim().toLowerCase()))) {
    throw new GoogleToolError("Orca doesn't move mail to Trash or Spam; archive it instead.")
  }
  const needUser = names.some((name) => !SYSTEM_LABELS[name.trim().toLowerCase()])
  const existing = needUser
    ? (await api.get('gmail', `${GMAIL}/labels`, parseGoogleJson(LabelsSchema))).labels
    : []
  const ids: string[] = []
  const created: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    const key = name.toLowerCase()
    const system = SYSTEM_LABELS[key]
    const found =
      system ??
      existing.find((label) => label.name.toLowerCase() === key && label.type !== 'system')?.id
    if (found) {
      ids.push(found)
      continue
    }
    if (!create) {
      throw new GoogleToolError(`There is no Gmail label "${name}".`)
    }
    const made = await api.send(
      'gmail',
      {
        method: 'POST',
        url: `${GMAIL}/labels`,
        json: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
      },
      parseGoogleJson(LabelSchema)
    )
    ids.push(made.id)
    created.push(made.name)
  }
  return { ids, created }
}

/** Adds and takes labels off threads or messages: archive is "take off Inbox", mark-read "Unread". */
export async function modifyGmail(
  api: GoogleApi,
  args: { refs: string[]; add: string[]; remove: string[] }
): Promise<GmailModifyView> {
  if (args.refs.length === 0) {
    throw new GoogleToolError('Name the mail: gmail:thread:… or gmail:msg:… refs.')
  }
  if (args.add.length + args.remove.length === 0) {
    throw new GoogleToolError('Say which labels to --add or --remove.')
  }
  const targets = args.refs.map(parseGmailRef)
  const add = await labelIds(api, args.add, true)
  const remove = await labelIds(api, args.remove, false)
  const labels = { addLabelIds: add.ids, removeLabelIds: remove.ids }
  const messages = targets.filter((target) => target.kind === 'msg').map((target) => target.id)
  if (messages.length > 0) {
    await api.send(
      'gmail',
      { method: 'POST', url: `${GMAIL}/messages/batchModify`, json: { ids: messages, ...labels } },
      () => true
    )
  }
  // Threads have no batch call; a few at a time stays under Gmail's per-user rate limit.
  await inBatches(
    targets.filter((target) => target.kind === 'thread'),
    GMAIL_CALLS_AT_ONCE,
    (target) =>
      api.send(
        'gmail',
        { method: 'POST', url: `${GMAIL}/threads/${target.id}/modify`, json: labels },
        () => true
      )
  )
  return {
    account: api.email,
    refs: targets.map((target) => `gmail:${target.kind}:${target.id}`),
    added: args.add.map((name) => name.trim()),
    removed: args.remove.map((name) => name.trim()),
    created: add.created
  }
}
