// Gmail refs as commands take them: Orca's gmail:thread:/gmail:msg: ids, a bare API id, or a Gmail
// web link. Newer links end in a view token (FMfcgz…): the API id's decimal as "f:<n>" (thread) or
// "msg-f:<n>", base64-encoded and rewritten as a base-40 number in consonants.
import { GoogleToolError } from './google-api-client'

export type GmailRef = { kind: 'thread' | 'msg'; id: string }

const TOKEN_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz'
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const HEX_ID = /^[0-9a-f]{16}$/i
const VIEW_TOKEN = new RegExp(`^[${TOKEN_ALPHABET}]{20,200}$`)
const GMAIL_LINK = 'https://mail.google.com/'

const UNREADABLE_LINK =
  "Orca can't read the id in that Gmail link. Find the mail with `orca gmail search` by its subject, or with rfc822msgid:<Message-ID>, and use the ref it prints."

/** A Gmail view token's API id, or null when it isn't one Orca can map to an API id. */
export function decodeGmailViewToken(token: string): GmailRef | null {
  if (!VIEW_TOKEN.test(token)) {
    return null
  }
  let value = 0n
  for (const char of token) {
    value = value * 40n + BigInt(TOKEN_ALPHABET.indexOf(char))
  }
  let base64 = ''
  for (; value > 0n; value /= 64n) {
    base64 = BASE64_ALPHABET[Number(value % 64n)] + base64
  }
  // "thread-a:" tokens (mail sent from the new UI) carry no API id.
  const payload = /^(thread-f|f|msg-f):(\d{1,20})$/.exec(Buffer.from(base64, 'base64').toString())
  if (!payload?.[1] || !payload[2]) {
    return null
  }
  const id = BigInt(payload[2]).toString(16)
  return id.length <= 16 ? { kind: payload[1] === 'msg-f' ? 'msg' : 'thread', id } : null
}

/** A Gmail id as Orca prints it, a bare id, or a Gmail web link to a thread or message. */
export function parseGmailRef(ref: string): GmailRef {
  const trimmed = ref.trim()
  const typed = /^gmail:(thread|msg):([A-Za-z0-9]+)$/.exec(trimmed)
  if (typed?.[1] && typed[2]) {
    return { kind: typed[1] === 'thread' ? 'thread' : 'msg', id: typed[2] }
  }
  if (trimmed.startsWith(GMAIL_LINK)) {
    // #inbox/<id>, #label/Work/<id>, #search/query/<id>?projector=1: the id is the last segment.
    const last = new URL(trimmed).hash.replace(/\?.*$/, '').split('/').at(-1) ?? ''
    if (HEX_ID.test(last)) {
      return { kind: 'thread', id: last.toLowerCase() }
    }
    const decoded = decodeGmailViewToken(last)
    if (decoded) {
      return decoded
    }
    throw new GoogleToolError(UNREADABLE_LINK)
  }
  if (HEX_ID.test(trimmed)) {
    return { kind: 'thread', id: trimmed }
  }
  throw new GoogleToolError(
    `"${trimmed.slice(0, 80)}" isn't a Gmail id. Use gmail:thread:… or gmail:msg:… from \`orca gmail search\`.`
  )
}

/** The account a Gmail link names (/u/<email>/ or ?authuser=<email>), a browser slot (/u/1/) that
 *  names none, or null for anything else. */
export function gmailLinkAccount(ref: string): { email: string } | 'slot' | null {
  const trimmed = ref.trim()
  if (!trimmed.startsWith(GMAIL_LINK)) {
    return null
  }
  const url = new URL(trimmed)
  const authuser = url.searchParams.get('authuser')
  const user = /^\/mail\/u\/([^/]+)/.exec(url.pathname)?.[1]
  const named = [authuser, user && decodeURIComponent(user)].find((value) => value?.includes('@'))
  if (named) {
    return { email: named.toLowerCase() }
  }
  return user !== undefined || authuser !== null ? 'slot' : null
}

/**
 * The account Gmail links pick when --account is missing: the one a link names, else the only
 * account the caller may use when a link carries a browser slot (/u/1/ is the browser's order,
 * not an account). Undefined leaves the usual default.
 */
export async function gmailLinksAccount(
  refs: readonly string[],
  accounts: () => Promise<readonly string[]>
): Promise<string | undefined> {
  // A link Orca can't read says so before any account question.
  refs.filter((ref) => ref.trim().startsWith(GMAIL_LINK)).forEach(parseGmailRef)
  const hints = refs.map(gmailLinkAccount)
  const named = [...new Set(hints.flatMap((hint) => (hint && hint !== 'slot' ? [hint.email] : [])))]
  if (named.length > 1) {
    throw new GoogleToolError(
      `Those Gmail links are from different accounts (${named.join(', ')}). Use one account per command.`
    )
  }
  if (named[0] || !hints.includes('slot')) {
    return named[0]
  }
  const emails = await accounts()
  if (emails.length === 1) {
    return emails[0]
  }
  throw new GoogleToolError(
    emails.length === 0
      ? 'No Google account is connected on this computer. Ask your owner to connect one in Orca.'
      : `That Gmail link's /u/N/ is the browser's account slot, not an account. Pass --account with one of: ${emails.join(', ')}.`
  )
}
