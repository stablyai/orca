import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type { AutomationWebhookConfig } from '../../shared/automations-types'

/** Headers a webhook request may carry the shared-secret token in. GitLab uses
 *  `X-Gitlab-Token`; `X-Webhook-Token` is the provider-agnostic fallback. */
const TOKEN_HEADERS = ['x-webhook-token', 'x-gitlab-token'] as const

/** Headers a webhook request may carry the HMAC signature in. GitHub uses
 *  `X-Hub-Signature-256` (prefixed `sha256=`); Gitea uses `X-Gitea-Signature`
 *  (bare hex); `X-Webhook-Signature` is the provider-agnostic fallback. */
const SIGNATURE_HEADERS = [
  'x-webhook-signature',
  'x-hub-signature-256',
  'x-gitea-signature'
] as const

export type WebhookSecretVerification = { ok: boolean; reason?: string }

export type WebhookRequestHeaders = Record<string, string | string[] | undefined>

/** Generate a high-entropy secret for a webhook trigger. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

function headerValue(headers: WebhookRequestHeaders, name: string): string | null {
  const raw = headers[name]
  if (typeof raw === 'string') {
    return raw
  }
  if (Array.isArray(raw) && typeof raw[0] === 'string') {
    return raw[0]
  }
  return null
}

/** Constant-time string compare that does not leak via early return; a length
 *  mismatch is reported as a non-match (the secret is high-entropy, so the
 *  length channel is not meaningful here). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

function stripSignaturePrefix(value: string): string {
  const eq = value.indexOf('=')
  // Why: GitHub sends `sha256=<hex>`; Gitea/others send bare hex. Strip an
  // algorithm prefix when present so both compare against the raw digest.
  return eq >= 0 ? value.slice(eq + 1).trim() : value.trim()
}

/** Verify an inbound webhook request against the automation's secret config.
 *  Returns ok for 'none' mode (the unguessable URL id is the only secret). */
export function verifyWebhookSecret(args: {
  config: AutomationWebhookConfig
  headers: WebhookRequestHeaders
  rawBody: string
}): WebhookSecretVerification {
  const { config, headers, rawBody } = args
  if (config.secretMode === 'none') {
    return { ok: true }
  }
  if (!config.secret) {
    // Why: a verifying mode with no secret can never authenticate a caller;
    // fail closed rather than silently accepting.
    return { ok: false, reason: 'no_secret_configured' }
  }

  if (config.secretMode === 'token') {
    for (const name of TOKEN_HEADERS) {
      const provided = headerValue(headers, name)
      if (provided !== null && safeEqual(provided, config.secret)) {
        return { ok: true }
      }
    }
    return { ok: false, reason: 'token_mismatch' }
  }

  // hmac_sha256
  const expected = createHmac('sha256', config.secret).update(rawBody).digest('hex')
  for (const name of SIGNATURE_HEADERS) {
    const provided = headerValue(headers, name)
    if (provided !== null && safeEqual(stripSignaturePrefix(provided).toLowerCase(), expected)) {
      return { ok: true }
    }
  }
  return { ok: false, reason: 'signature_mismatch' }
}
