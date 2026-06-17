import type { ClassifiedMatrixError } from './types'

// Pure, side-effect-free formatting/parsing helpers for the Matrix adapter.
// Kept out of client.ts so they can be unit-tested without matrix-js-sdk.

// Matrix error codes we recognize for classification. The SDK surfaces these on
// MatrixError as `errcode`; we also fall back to HTTP status and message text so
// non-SDK errors (DNS, fetch aborts) still classify usefully.
const FORBIDDEN_CODES = new Set(['M_FORBIDDEN'])
const AUTH_CODES = new Set(['M_UNKNOWN_TOKEN', 'M_MISSING_TOKEN', 'M_USER_DEACTIVATED'])
const RATE_LIMIT_CODES = new Set(['M_LIMIT_EXCEEDED'])

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

// Maps an arbitrary thrown value to a stable {type, message}. Callers return or
// throw this so failures surface in-band with an actionable category instead of
// being swallowed.
export function classifyMatrixError(error: unknown): ClassifiedMatrixError {
  const record =
    error && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : ({} as Record<string, unknown>)
  // Prefer Error.message; fall back to a `message` field on plain objects (e.g.
  // an error serialized across IPC) before stringifying the value itself.
  const message =
    error instanceof Error ? error.message : (readString(record, 'message') ?? String(error))

  const errcode = readString(record, 'errcode')
  const httpStatus = readNumber(record, 'httpStatus') ?? readNumber(record, 'status')

  if (errcode) {
    if (AUTH_CODES.has(errcode)) {
      return { type: 'auth', message }
    }
    if (FORBIDDEN_CODES.has(errcode)) {
      return { type: 'forbidden', message }
    }
    if (RATE_LIMIT_CODES.has(errcode)) {
      return { type: 'rate_limit', message }
    }
  }

  if (httpStatus === 401) {
    return { type: 'auth', message }
  }
  if (httpStatus === 403) {
    return { type: 'forbidden', message }
  }
  if (httpStatus === 429) {
    return { type: 'rate_limit', message }
  }

  // Why: abort/timeout/connection-refused never carry a Matrix errcode. Detect
  // them by name/message so the adapter reports a network problem, not "unknown".
  const lowered = message.toLowerCase()
  const name = error instanceof Error ? error.name.toLowerCase() : ''
  if (
    name === 'aborterror' ||
    lowered.includes('econn') ||
    lowered.includes('enotfound') ||
    lowered.includes('etimedout') ||
    lowered.includes('network') ||
    lowered.includes('fetch failed') ||
    lowered.includes('timed out') ||
    lowered.includes('timeout')
  ) {
    return { type: 'network', message }
  }

  return { type: 'unknown', message }
}

// Prefixes an outbound body with the session handle so room readers (and inbound
// routing) can tell which Orca session spoke. Matches the design-doc format
// `[orca <handle>] <body>`.
export function formatHandlePrefix(handle: string, body: string): string {
  return `[orca ${handle}] ${body}`
}

// Conservative handle charset: letters, digits, dash, underscore. A leading
// `@handle ` token routes an inbound message to a session. Anything outside the
// charset means "no handle" rather than a partial/ambiguous match.
const HANDLE_TOKEN = /^@([A-Za-z0-9_-]+)\s+([\s\S]*)$/

export function parseInboundHandle(body: string): { handle: string | null; rest: string } {
  const match = HANDLE_TOKEN.exec(body)
  if (!match) {
    return { handle: null, rest: body }
  }
  return { handle: match[1], rest: match[2] }
}

// Matrix rich replies (and Cinny's quote-reply) prepend a fallback block to the
// plain `body`: a run of quoted lines (each starting with "> ", e.g.
// `> <@user:hs> original`) followed by a blank line, then the actual reply text.
// We route replies by the m.in_reply_to relation, so we strip that fallback to
// recover what the operator actually typed. Only a LEADING quote block is
// stripped — a body whose later lines happen to start with "> " is untouched.
export function stripReplyFallback(body: string): string {
  if (!body.startsWith('> ')) {
    return body
  }
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && lines[i].startsWith('> ')) {
    i += 1
  }
  // Consume exactly one blank separator line between the quote block and the
  // reply, when present; a missing separator just means no further trim. Handle
  // CRLF bodies where the "blank" line is "\r", not "".
  if (i < lines.length && (lines[i] === '' || lines[i] === '\r')) {
    i += 1
  }
  return lines.slice(i).join('\n')
}
