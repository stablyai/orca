const KEY_LIKE_PATTERNS: RegExp[] = [
  /\b(?:sk|gsk|xi|sk_live|sk_test)[-_][A-Za-z0-9_-]{6,}/g,
  /\bAIza[0-9A-Za-z_-]{10,}/g,
  /\bAQ\.[0-9A-Za-z._-]{10,}/g,
  /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:api[_-]?key|key|token)=[^&\s"']+/gi,
  // Why: providers echo unknown keys verbatim; long opaque runs are redacted defensively.
  /\b[A-Za-z0-9_-]{32,}\b/g
]

const MAX_PROVIDER_MESSAGE_LENGTH = 300

/** Strips anything shaped like a credential from a provider-supplied message. */
export function redactCloudSpeechSecrets(message: string): string {
  let sanitized = message
  for (const pattern of KEY_LIKE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) =>
      /^(Bearer|Token)\s/i.test(match) ? `${match.split(/\s+/)[0]} [redacted]` : '[redacted]'
    )
  }
  sanitized = sanitized.replace(/\s+/g, ' ').trim()
  return sanitized.length > MAX_PROVIDER_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_PROVIDER_MESSAGE_LENGTH)}…`
    : sanitized
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

/** Pulls the human message out of the error JSON shapes the supported providers return. */
export function extractProviderErrorMessage(body: unknown): string | null {
  const root = asRecord(body)
  if (!root) {
    return typeof body === 'string' ? pickString(body) : null
  }
  const error = asRecord(root.error)
  const detail = asRecord(root.detail)
  return pickString(
    error?.message,
    root.error,
    detail?.message,
    root.detail,
    root.message,
    root.error_message,
    root.err_msg,
    root.reason
  )
}

/** Reads a failed response into one sanitized sentence-sized message. */
export async function readProviderErrorMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '')
  let message: string | null = null
  try {
    message = extractProviderErrorMessage(JSON.parse(raw))
  } catch {
    message = pickString(raw)
  }
  return redactCloudSpeechSecrets(message ?? response.statusText ?? '') || `HTTP ${response.status}`
}

export function describeProviderFailure(label: string, error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `${label} did not respond in time.`
  }
  const message = error instanceof Error ? error.message : String(error)
  // Why: undici echoes the whole rejected header value, which is the key itself.
  if (/^Headers\.append|invalid header/i.test(message)) {
    return 'API key contains invalid characters.'
  }
  return redactCloudSpeechSecrets(message) || `${label} request failed.`
}

export const CLOUD_SPEECH_REQUEST_TIMEOUT_MS = 120_000

/** Throws a sanitized "<Provider> transcription failed: …" error for a non-2xx response. */
export async function assertProviderResponseOk(label: string, response: Response): Promise<void> {
  if (response.ok) {
    return
  }
  const message = await readProviderErrorMessage(response)
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${label} rejected the API key (${response.status}): ${message}`)
  }
  throw new Error(`${label} transcription failed (${response.status}): ${message}`)
}
