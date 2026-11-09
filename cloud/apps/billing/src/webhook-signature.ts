// Stripe webhook signature verification (https://docs.stripe.com/webhooks#verify-manually):
// header `Stripe-Signature: t=<unix>,v1=<hex hmac>[,v1=...]`, HMAC-SHA256 over `${t}.${rawBody}`
// keyed by the endpoint secret. Implemented on WebCrypto so the Worker carries no Stripe SDK.
export const DEFAULT_TOLERANCE_SECONDS = 300

export type SignatureResult = { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' }

const encoder = new TextEncoder()

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Constant-time over equal-length strings; length itself is not secret (always 64 hex chars). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function parseHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const index = part.indexOf('=')
    if (index <= 0) {
      continue
    }
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key === 't' && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value)
    } else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value)
    }
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures }
}

export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secrets: readonly string[],
  nowMs: number = Date.now(),
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS
): Promise<SignatureResult> {
  const parsed = header ? parseHeader(header) : null
  const usable = secrets.filter((secret) => secret.length > 0)
  if (!parsed || usable.length === 0) {
    return { ok: false, reason: 'malformed' }
  }
  if (Math.abs(nowMs / 1000 - parsed.timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'stale' }
  }
  const signedPayload = `${parsed.timestamp}.${rawBody}`
  for (const secret of usable) {
    const expected = await hmacHex(secret, signedPayload)
    // Check every candidate so timing does not reveal which one matched.
    let matched = false
    for (const signature of parsed.signatures) {
      matched = constantTimeEqual(expected, signature) || matched
    }
    if (matched) {
      return { ok: true }
    }
  }
  return { ok: false, reason: 'mismatch' }
}

export function splitSecrets(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean)
}
