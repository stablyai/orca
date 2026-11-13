// SEC-6c: the only log sink for code that handles secret values (secrets.ts, session-env.ts,
// env-refresh.ts, egress-proxy.ts, secret-events.ts). Lines are structured JSON with names and
// counts by design; this layer is the backstop when a field slips through anyway, for example an
// error message or upstream body that quotes a key. Two passes over the serialized line:
//   1. exact values the caller is handling right now (`known`), replaced wherever they appear;
//   2. credential shapes (provider API keys, GitHub tokens, AWS key ids, JWTs, bearer headers).
// test/secret-log.test.ts fails when one of these files calls console directly, and when a
// planted value reaches the sink.

const REDACTED = '[redacted]'

/** Known credential shapes. Kept specific so names, ids and counts in log lines survive. */
const PATTERNS: readonly RegExp[] = [
  // Anthropic, OpenAI (incl. sk-proj-), OpenRouter and other `sk-` keys.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens: classic, OAuth, app installation/user, refresh and fine-grained PATs.
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Google API keys.
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  // Slack tokens.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // Vercel AI Gateway keys.
  /\bvck_[A-Za-z0-9]{20,}/g,
  // JWTs (session tokens, OIDC tokens).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Authorization header values.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi
]

/** Shorter values are not matched by exact text: they would erase ordinary words and ids. */
const MIN_KNOWN_LENGTH = 8

function escapeJson(value: string): string {
  // The value as it appears inside a JSON string (quotes, backslashes, control characters escaped).
  return JSON.stringify(value).slice(1, -1)
}

export function redactLine(line: string, known: Iterable<string> = []): string {
  let out = line
  const values = [...new Set(known)].filter((value) => value.length >= MIN_KNOWN_LENGTH)
  // Longest first, so a value that contains another is removed whole.
  values.sort((a, b) => b.length - a.length)
  for (const value of values) {
    for (const form of new Set([value, escapeJson(value)])) {
      out = out.split(form).join(REDACTED)
    }
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, scheme?: string) =>
      typeof scheme === 'string' && /^(bearer|basic)$/i.test(scheme) ? `${scheme} ${REDACTED}` : REDACTED
    )
  }
  return out
}

/** Error-like values become their name and message (redacted with the rest), never their stack. */
function serializable(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message }
  }
  return value
}

export type SecretLogSink = (line: string) => void
let sink: SecretLogSink = (line) => console.log(line)

/** Tests only: capture lines exactly as they would reach Workers logs. Returns a restore function. */
export function setSecretLogSink(next: SecretLogSink): () => void {
  const previous = sink
  sink = next
  return () => {
    sink = previous
  }
}

/** One structured log line. `known`: values in scope at the call site that must never be written. */
export function secretLog(event: string, fields: Record<string, unknown> = {}, known: Iterable<string> = []): void {
  let line: string
  try {
    line = JSON.stringify({ event, ...fields }, (_key, value: unknown) => serializable(value))
  } catch {
    line = JSON.stringify({ event, unserializable: true })
  }
  sink(redactLine(line, known))
}
