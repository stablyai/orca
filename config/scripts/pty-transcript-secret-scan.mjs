// Finds account identifiers and credentials in a captured PTY transcript before it is committed.
import os from 'node:os'

// Why same-length replacements: a transcript's value is its exact wrapping and column
// alignment. Shortening a redacted span reflows the screen and destroys the evidence.
const EMAIL_DOMAIN = '@example.com'
const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000'

/** Ordered most-specific first; the first pattern to claim a span owns it. */
function buildPatterns() {
  const username = os.userInfo().username
  const hostname = os.hostname()
  const patterns = [
    { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
    { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{20,}/g },
    { kind: 'google-refresh-token', re: /\b1\/\/[0-9A-Za-z_-]{20,}/g },
    { kind: 'vendor-key', re: /\b(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-)[A-Za-z0-9_-]{16,}/g },
    { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
    { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    // Why a UUID counts: agy prints a resumable conversation id on exit, and installation and
    // project ids look the same. They identify the operator's session, not just its shape.
    { kind: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
    { kind: 'opaque-token', re: /\b[A-Za-z0-9_-]{40,}\b/g }
  ]
  if (username.length >= 3) {
    patterns.splice(5, 0, { kind: 'local-username', re: literalPattern(username) })
  }
  if (hostname.length >= 3) {
    patterns.splice(5, 0, { kind: 'local-hostname', re: literalPattern(hostname) })
  }
  return patterns
}

function literalPattern(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
}

/**
 * @param {string} text raw transcript, escapes intact
 * @returns {{kind: string, line: number, column: number, index: number, match: string}[]}
 */
export function scanTranscriptForSecrets(text) {
  const claimed = []
  const findings = []
  for (const { kind, re } of buildPatterns()) {
    re.lastIndex = 0
    let match = re.exec(text)
    while (match !== null) {
      const start = match.index
      const end = start + match[0].length
      if (!claimed.some(([from, to]) => start < to && end > from)) {
        claimed.push([start, end])
        if (!isAlreadyScrubbed(kind, match[0])) {
          findings.push({ kind, index: start, match: match[0], ...locate(text, start) })
        }
      }
      match = re.exec(text)
    }
  }
  return findings.sort((left, right) => left.index - right.index)
}

// Why: a scrubbed fixture must verify clean, so this scanner has to recognise its own
// placeholders — otherwise "prove it's gone" can never pass and the check gets ignored.
const PLACEHOLDER_DOMAIN_RE = /@(?:example\.(?:com|org|net)|localhost)$/i

function isAlreadyScrubbed(kind, match) {
  if (kind === 'email') {
    return PLACEHOLDER_DOMAIN_RE.test(match)
  }
  if (kind === 'uuid') {
    return match.toLowerCase() === PLACEHOLDER_UUID
  }
  return /^(.)\1*$/.test(match)
}

function locate(text, index) {
  let line = 1
  let lineStart = 0
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1
      lineStart = cursor + 1
    }
  }
  return { line, column: index - lineStart + 1 }
}

/** Same-length stand-in so redaction cannot reflow the captured screen. */
export function placeholderFor(kind, length) {
  if (kind === 'uuid' && length === PLACEHOLDER_UUID.length) {
    return PLACEHOLDER_UUID
  }
  if (kind === 'email' && length > EMAIL_DOMAIN.length) {
    return 'u'.repeat(length - EMAIL_DOMAIN.length) + EMAIL_DOMAIN
  }
  return kind === 'local-username' || kind === 'local-hostname'
    ? 'x'.repeat(length)
    : 'X'.repeat(length)
}

/** @returns {{text: string, redacted: number}} */
export function redactTranscript(text) {
  const findings = scanTranscriptForSecrets(text)
  let out = ''
  let cursor = 0
  for (const finding of findings) {
    out += text.slice(cursor, finding.index)
    out += placeholderFor(finding.kind, finding.match.length)
    cursor = finding.index + finding.match.length
  }
  return { text: out + text.slice(cursor), redacted: findings.length }
}

export function formatFindings(label, findings) {
  if (findings.length === 0) {
    return `${label}: clean — no account identifier or credential shapes found.`
  }
  const rows = findings.map(
    (finding) => `  ${finding.line}:${finding.column}  ${finding.kind}  ${preview(finding.match)}`
  )
  return [`${label}: ${findings.length} finding(s) — scrub before committing.`, ...rows].join('\n')
}

// Why a codepoint test and not a character class: a control-byte range written as an escape is
// folded back into raw 0x00-0x1f bytes by the formatter, which makes this file binary to the VCS
// and leaves the one file gating real PTY data into history unreviewable in a diff.
function preview(value) {
  const head = value.length <= 24 ? value : `${value.slice(0, 21)}...`
  let printable = ''
  for (const char of head) {
    printable += (char.codePointAt(0) ?? 0) < 0x20 ? '?' : char
  }
  return printable
}
