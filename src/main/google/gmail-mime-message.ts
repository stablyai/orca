// The RFC 5322 message a Gmail draft carries: plain-text body, optional attachments, and the
// threading headers that keep a reply in its conversation. Gmail fills in From and Date.
import { randomBytes } from 'node:crypto'
import { filePreviewForPath } from '../../shared/file-preview/file-preview-kind'
import { mailboxAddress } from '../../shared/google/email-address-list'
import { GoogleToolError } from './google-api-client'

export type MimeAttachment = { name: string; type?: string; data: Buffer }

export type MimeDraft = {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  inReplyTo?: string
  references?: string
  attachments: MimeAttachment[]
}

const ASCII = /^[\x20-\x7e]*$/

/** A header value with no line breaks: someone else's subject must not add headers. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** RFC 2047 encoded words, each under the 75-character limit, split between characters. */
export function encodeHeaderText(value: string): string {
  const text = oneLine(value)
  if (ASCII.test(text)) {
    return text
  }
  const words: string[] = []
  let chunk = ''
  for (const char of text) {
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += char
  }
  words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join(' ')
}

const EMAIL = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/

/** "Sam Lee <sam@x.com>" or "sam@x.com" as one header address, the name encoded when needed. */
export function formatAddress(entry: string): string {
  const text = oneLine(entry)
  const named = /^(.*)<([^<>]+)>$/.exec(text)
  const email = (named?.[2] ?? text).trim()
  if (!EMAIL.test(email)) {
    throw new GoogleToolError(
      `"${text.slice(0, 80)}" isn't an email address. \`orca contacts find <name>\` looks one up.`
    )
  }
  const name = named?.[1]?.trim().replace(/^"(.*)"$/, '$1')
  if (!name) {
    return email
  }
  return ASCII.test(name)
    ? `"${name.replace(/["\\]/g, '\\$&')}" <${email}>`
    : `${encodeHeaderText(name)} <${email}>`
}

/** The bare address of a header entry, lowercased, for comparing who is who. */
export function addressOf(entry: string): string {
  return mailboxAddress(entry) ?? entry.trim().toLowerCase()
}

function base64Lines(data: Buffer): string {
  return (data.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
}

function fileNameParam(name: string): string {
  const clean = oneLine(name).replace(/[\\/]/g, '_')
  return ASCII.test(clean)
    ? `filename="${clean.replace(/["\\]/g, '\\$&')}"`
    : `filename*=UTF-8''${encodeURIComponent(clean)}`
}

function mimeTypeOf(attachment: MimeAttachment): string {
  return (
    attachment.type ?? filePreviewForPath(attachment.name)?.mimeType ?? 'application/octet-stream'
  )
}

export function buildMimeMessage(
  draft: MimeDraft,
  boundary = randomBytes(12).toString('hex')
): string {
  const headers = [
    ...(draft.to.length > 0 ? [`To: ${draft.to.map(formatAddress).join(', ')}`] : []),
    ...(draft.cc.length > 0 ? [`Cc: ${draft.cc.map(formatAddress).join(', ')}`] : []),
    ...(draft.bcc.length > 0 ? [`Bcc: ${draft.bcc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeHeaderText(draft.subject)}`,
    ...(draft.inReplyTo ? [`In-Reply-To: ${oneLine(draft.inReplyTo)}`] : []),
    ...(draft.references ? [`References: ${oneLine(draft.references)}`] : []),
    'MIME-Version: 1.0'
  ]
  const text = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(draft.body.replace(/\r?\n/g, '\r\n')))
  ]
  if (draft.attachments.length === 0) {
    return [...headers, ...text].join('\r\n')
  }
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    ...text,
    ...draft.attachments.flatMap((attachment) => [
      `--${boundary}`,
      `Content-Type: ${mimeTypeOf(attachment)}`,
      `Content-Disposition: attachment; ${fileNameParam(attachment.name)}`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(attachment.data)
    ]),
    `--${boundary}--`,
    ''
  ].join('\r\n')
}
