import { createPrivateKey, type KeyObject, sign } from 'node:crypto'
import type { ApnsCredentials } from './config.js'

// Apple rejects a provider token older than an hour and throttles reissue
// under about 20 minutes, so 50 minutes is the safe rotation point.
export const APNS_TOKEN_ROTATION_MS = 50 * 60 * 1000

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export class ApnsAuthenticationToken {
  private readonly privateKey: KeyObject
  private cached: { token: string; issuedAtMs: number } | null = null

  constructor(
    private readonly credentials: ApnsCredentials,
    private readonly now: () => number = Date.now,
    private readonly rotationMs: number = APNS_TOKEN_ROTATION_MS
  ) {
    this.privateKey = createPrivateKey(credentials.keyPem)
  }

  value(): string {
    const nowMs = this.now()
    if (this.cached && nowMs - this.cached.issuedAtMs < this.rotationMs) return this.cached.token
    const header = base64UrlJson({ alg: 'ES256', kid: this.credentials.keyId })
    const payload = base64UrlJson({
      iss: this.credentials.teamId,
      iat: Math.floor(nowMs / 1000)
    })
    const signingInput = `${header}.${payload}`
    // ES256 requires the raw r||s pair; Node emits DER unless asked otherwise.
    const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363'
    }).toString('base64url')
    const token = `${signingInput}.${signature}`
    this.cached = { token, issuedAtMs: nowMs }
    return token
  }
}
