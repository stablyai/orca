import {
  readFetchResponseJsonWithinLimit,
  readFetchResponseTextWithinLimit
} from '../../shared/network/fetch-response-body'

const GITEA_AUTH_ERROR_MAX_LEN = 280
const GITEA_AUTH_ERROR_MAX_BODY_BYTES = 4 * 1024
const SECRET_QUERY_KEY_RE =
  /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?token|token|key|api[_-]?key|client[_-]?secret|secret|password|pass|passphrase|pwd|auth|credentials?|sig|signature|x-amz-signature|x-goog-signature)$/i
const AUTH_SCHEME_VALUE_RE = /^(\s*(?:token|bearer|basic)\s+)\S.*$/i
const UNCLOSED_AUTH_SCHEME_VALUE_RE = /^(\s*(?:token|bearer|basic)\s+)[^\s"',\]]+/i

function decodePercentKey(rawKey: string): string {
  return rawKey.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16))
  )
}

function countPrecedingBackslashes(text: string, index: number): number {
  let slashCount = 0
  while (index - 1 - slashCount >= 0 && text[index - 1 - slashCount] === '\\') {
    slashCount += 1
  }
  return slashCount
}

function readQuoteAt(text: string, quoteIdx: number): string | null {
  if (quoteIdx < 0) {
    return null
  }
  const ch = text[quoteIdx]
  if (ch !== '"' && ch !== "'") {
    return null
  }
  const escaped = countPrecedingBackslashes(text, quoteIdx) % 2 === 1
  const beforeIdx = escaped ? quoteIdx - 2 : quoteIdx - 1
  // Require a non-word boundary before the quote so apostrophes inside URLs (e.g. O'Reilly) stay ignored.
  if (beforeIdx >= 0 && /[A-Za-z0-9_]/.test(text[beforeIdx])) {
    return null
  }
  return escaped ? `\\${ch}` : ch
}

function findOpeningQuoteBefore(text: string, offset: number): string | null {
  let tokenStart = offset
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) {
    tokenStart -= 1
  }
  const head = text.slice(tokenStart, offset)
  const schemeMatch = /(?:^|[\s"'([:=])https?:\/\//i.exec(head)
  if (schemeMatch) {
    const schemeOffset = schemeMatch[0].search(/https?:\/\//i)
    return readQuoteAt(text, tokenStart + schemeMatch.index + schemeOffset - 1)
  }
  return readQuoteAt(text, offset - 1)
}

function splitTrailingOuterQuote(value: string, openQuote: string | null): string {
  if (!openQuote) {
    return ''
  }
  const idx = value.lastIndexOf(openQuote)
  if (idx === -1) {
    return ''
  }
  const suffix = value.slice(idx)
  return /^(?:[,.;:!?)\]}'"\\]*|["']>(?:[^<"']|<\/[a-zA-Z]+>)*)$/.test(suffix) ? suffix : ''
}

function readLiteralQuotePrefix(text: string, index: number): string | null {
  const ch = text[index]
  if (ch === '"' || ch === "'") {
    return ch
  }
  if (ch === '\\' && (text[index + 1] === '"' || text[index + 1] === "'")) {
    return text.slice(index, index + 2)
  }
  return null
}

function scanQuotedLiteral(
  text: string,
  start: number,
  quote: string
): { contentStart: number; closeIdx: number; end: number } | null {
  const contentStart = start + quote.length
  if (quote.length === 2) {
    const closeIdx = text.indexOf(quote, contentStart)
    return closeIdx === -1 ? null : { contentStart, closeIdx, end: closeIdx + 2 }
  }
  for (let i = contentStart; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (text[i] === quote) {
      return { contentStart, closeIdx: i, end: i + 1 }
    }
  }
  return null
}

function redactAuthSchemeValue(value: string): string {
  const match = AUTH_SCHEME_VALUE_RE.exec(value)
  return match ? `${match[1]}[REDACTED]` : value
}

function redactQuotedAuthItem(text: string, start: number): { output: string; end: number } | null {
  const quote = readLiteralQuotePrefix(text, start)
  if (!quote) {
    return null
  }
  const scanned = scanQuotedLiteral(text, start, quote)
  if (scanned) {
    const inner = redactAuthSchemeValue(text.slice(scanned.contentStart, scanned.closeIdx))
    return { output: `${quote}${inner}${quote}`, end: scanned.end }
  }
  const contentStart = start + quote.length
  const unclosed = UNCLOSED_AUTH_SCHEME_VALUE_RE.exec(text.slice(contentStart))
  return unclosed
    ? { output: `${quote}${unclosed[1]}[REDACTED]`, end: contentStart + unclosed[0].length }
    : { output: quote, end: contentStart }
}

function redactAuthArray(text: string, openBracketIdx: number): { output: string; end: number } {
  let output = '['
  let i = openBracketIdx + 1
  while (i < text.length) {
    const ch = text[i]
    if (/\s|,/.test(ch)) {
      output += ch
      i += 1
      continue
    }
    if (ch === ']') {
      return { output: `${output}]`, end: i + 1 }
    }
    const quoted = redactQuotedAuthItem(text, i)
    if (quoted) {
      output += quoted.output
      i = quoted.end
      continue
    }
    let itemEnd = i
    while (itemEnd < text.length && text[itemEnd] !== ',' && text[itemEnd] !== ']') {
      itemEnd += 1
    }
    output += redactAuthSchemeValue(text.slice(i, itemEnd))
    i = itemEnd
  }
  return { output, end: i }
}

/** Linear O(n) header scanner avoids regex backtracking on adversarial error bodies. */
function redactAuthorizationHeaders(text: string): string {
  const headerRe = /(?:\\?["'])?(?:proxy-)?authorization(?:\\?["'])?\s*[:=]\s*/gi
  let result = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = headerRe.exec(text)) !== null) {
    const valueStart = match.index + match[0].length
    if (valueStart < cursor) {
      continue
    }
    result += text.slice(cursor, valueStart)
    cursor = valueStart
    if (text[valueStart] === '[') {
      const arrayResult = redactAuthArray(text, valueStart)
      result += arrayResult.output
      cursor = arrayResult.end
    } else {
      const quoted = redactQuotedAuthItem(text, valueStart)
      if (quoted) {
        result += quoted.output
        cursor = quoted.end
      } else {
        const plain = /^((?:token|bearer|basic)\s+)\S+/i.exec(text.slice(valueStart))
        if (plain) {
          result += `${plain[1]}[REDACTED]`
          cursor = valueStart + plain[0].length
        }
      }
    }
    headerRe.lastIndex = Math.max(headerRe.lastIndex, cursor)
  }
  return result + text.slice(cursor)
}

/** Keep server auth text, but never echo the configured token, query secrets, or auth headers. */
export function sanitizeGiteaAuthError(raw: string, token: string | null): string | null {
  let text = raw.replace(/\s+/g, ' ').trim()
  if (!text) {
    return null
  }
  text = text
    .replace(/(https?:\/\/[^/\s"'?#:]+:)[^@\s"'/?#]+(@)/gi, '$1[REDACTED]$2')
    .replace(/(https?:\/\/)(?!\[REDACTED\])[^/\s"'?#:@]+(@)/gi, '$1[REDACTED]$2')
    .replace(
      /(&amp;|&#0*38;|&#x0*26;|[?&])([^=&\s]+)=([^\s&]*)/gi,
      (fullMatch, delim: string, rawKey: string, value: string, offset: number, full: string) => {
        if (!SECRET_QUERY_KEY_RE.test(decodePercentKey(rawKey))) {
          return fullMatch
        }
        const nextIdx = offset + fullMatch.length
        const isFinalParam = nextIdx >= full.length || /\s/.test(full[nextIdx] ?? '')
        const openQuote = isFinalParam ? findOpeningQuoteBefore(full, offset) : null
        const suffix = splitTrailingOuterQuote(value, openQuote)
        return `${delim}${rawKey}=[REDACTED]${suffix}`
      }
    )
    .replace(
      /(%3f|%26)([^=&\s]+?)(%3d)((?:(?!%26)[^\s"&])+)/gi,
      (fullMatch, delim: string, rawKey: string, eq: string) =>
        SECRET_QUERY_KEY_RE.test(decodePercentKey(rawKey))
          ? `${delim}${rawKey}${eq}[REDACTED]`
          : fullMatch
    )
  text = redactAuthorizationHeaders(text)
  if (token) {
    text = text.split(token).join('[REDACTED]')
  }
  if (text.length > GITEA_AUTH_ERROR_MAX_LEN) {
    text = `${text.slice(0, GITEA_AUTH_ERROR_MAX_LEN - 3)}...`
  }
  return text
}

function extractGiteaParsedErrorCandidate(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  if ('message' in parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message.trim()
  }
  if ('error' in parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error.trim()
  }
  return null
}

async function readGiteaErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = await readFetchResponseTextWithinLimit(response, GITEA_AUTH_ERROR_MAX_BODY_BYTES)
    const trimmed = body.trim()
    if (!trimmed) {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const candidate = extractGiteaParsedErrorCandidate(parsed)
      if (candidate) {
        return candidate
      }
    } catch {
      return trimmed
    }
  } catch {
    // Body already consumed, oversized, or stream failed — fall through to status fallback.
  }
  return null
}

export type GiteaUserProbe = {
  login?: string | null
  username?: string | null
  full_name?: string | null
}

function parseGiteaUserProbe(data: unknown): GiteaUserProbe | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const probe: GiteaUserProbe = {}
  if ('login' in data && (typeof data.login === 'string' || data.login === null)) {
    probe.login = data.login
  }
  if ('username' in data && (typeof data.username === 'string' || data.username === null)) {
    probe.username = data.username
  }
  if ('full_name' in data && (typeof data.full_name === 'string' || data.full_name === null)) {
    probe.full_name = data.full_name
  }
  return probe
}

/** Probe `/user` and keep the server error body on non-2xx (requestJson collapses it). */
export async function probeGiteaAuthenticatedUser(
  baseUrl: string,
  token: string
): Promise<{ user: GiteaUserProbe | null; authError: string | null }> {
  try {
    const response = await fetch(new URL(`${baseUrl.replace(/\/+$/, '')}/user`), {
      headers: {
        Accept: 'application/json',
        Authorization: `token ${token}`
      },
      signal: AbortSignal.timeout(4000)
    })
    if (!response.ok) {
      const raw = (await readGiteaErrorMessage(response)) ?? `HTTP ${response.status}`
      return { user: null, authError: sanitizeGiteaAuthError(raw, token) }
    }
    const data = await readFetchResponseJsonWithinLimit<unknown>(response)
    return { user: parseGiteaUserProbe(data), authError: null }
  } catch {
    return { user: null, authError: null }
  }
}
