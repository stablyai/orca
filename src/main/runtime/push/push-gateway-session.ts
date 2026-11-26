import { z } from 'zod'
import type { E2EEKeypair } from '../rpc/server/pairing/e2ee-keypair'
import { deriveRelayHostId } from '../mobile-cloud-relay/director/relay-http-client'
import { answerPushHostChallenge } from './push-host-proof'
import type { MobilePushServiceProblem } from '../../../shared/notifications/mobile-push-contract'
import {
  postPushGatewayJson,
  pushServiceProblemOf,
  readPushGatewayJson,
  type PushGatewayFailure
} from './push-gateway-response'

// Renew early so expiry between check and send cannot consume the single retry.
const SESSION_RENEWAL_MARGIN_MS = 60_000
// Cache proof refusal to avoid repeating identical failed handshakes on every dispatch.
const HANDSHAKE_REFUSAL_TTL_MS = 30_000
const HANDSHAKE_RATE_LIMIT_TTL_MS = 60_000

const ChallengeResponseSchema = z
  .object({
    challengeId: z.string().min(1).max(512),
    gatewayEphemeralPublicKeyB64: z.string().min(1).max(128),
    nonceB64: z.string().min(1).max(128),
    ciphertextB64: z
      .string()
      .min(1)
      .max(8 * 1024),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

const SessionResponseSchema = z
  .object({
    sessionToken: z.string().min(1).max(1024),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    hostFingerprint: z.string().min(1).max(64)
  })
  .strict()

export type PushSession = { token: string; expiresAt: number }
export type PushSessionOutcome = { ok: true; session: PushSession } | PushGatewayFailure

type PushGatewaySessionOptions = {
  origin: string
  keypair: E2EEKeypair
  fetchImpl: typeof globalThis.fetch
  now: () => number
}

export class PushGatewaySession {
  private readonly origin: string
  private readonly keypair: E2EEKeypair
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number
  readonly hostFingerprint: string
  private session: PushSession | null = null
  private pending: Promise<PushSessionOutcome> | null = null
  private negative: { at: number; ttlMs: number; failure: PushGatewayFailure } | null = null
  // One log line per distinct failure, so a host stuck on it does not log every retry.
  private loggedFailure: string | null = null
  private refusedClockSkewMs: number | null = null
  private lastFailure: MobilePushServiceProblem | null = null

  constructor(options: PushGatewaySessionOptions) {
    this.origin = options.origin
    this.keypair = options.keypair
    this.fetchImpl = options.fetchImpl
    this.now = options.now
    this.hostFingerprint = deriveRelayHostId(options.keypair.publicKey)
  }

  /** How far off this host's clock was when the last sign-in was refused for it; null otherwise. */
  clockSkewMs(): number | null {
    return this.refusedClockSkewMs
  }

  /** Why the last sign-in failed; null once signed in, or before any attempt. */
  signInFailure(): MobilePushServiceProblem | null {
    return this.lastFailure
  }

  /** Invalidate only the token that received 401; concurrent requests may already have installed its replacement. */
  async ensure(staleToken: string | null): Promise<PushSessionOutcome> {
    if (staleToken !== null && this.session?.token === staleToken) {
      this.session = null
    }
    const cached = this.session
    if (cached && cached.expiresAt - SESSION_RENEWAL_MARGIN_MS > this.now()) {
      return this.signedIn(cached)
    }
    if (this.negative && this.isCached(this.negative)) {
      return this.negative.failure
    }
    // Concurrent sends must not each burn a challenge; share one handshake.
    this.pending ??= this.open().finally(() => {
      this.pending = null
    })
    return await this.pending
  }

  private async open(): Promise<PushSessionOutcome> {
    const challenge = await this.handshakePost(
      '/v1/host/challenge',
      { v: 1, hostPublicKeyB64: this.keypair.publicKeyB64 },
      ChallengeResponseSchema
    )
    if (!challenge.ok) {
      return this.remember(challenge, 'the push service refused this host')
    }
    const invalid: string[] = []
    let clockSkewMs: number | undefined
    const proofB64 = answerPushHostChallenge(challenge.value, {
      gatewayOrigin: this.origin,
      hostFingerprint: this.hostFingerprint,
      hostPublicKey: this.keypair.publicKey,
      hostSecretKey: this.keypair.secretKey,
      now: this.now,
      onInvalid: (reason) => invalid.push(reason),
      onClockSkew: (skewMs) => {
        clockSkewMs = skewMs
      }
    })
    if (!proofB64) {
      // A challenge this host cannot answer is a refusal, not a dropped packet.
      return clockSkewMs === undefined
        ? this.remember(
            { ok: false, reason: 'rejected' },
            `its challenge did not verify (${invalid.join(', ') || 'unreadable'})`
          )
        : this.remember({ ok: false, reason: 'rejected', clockSkewMs }, clockSkewCause(clockSkewMs))
    }
    const parsed = await this.handshakePost(
      '/v1/host/session',
      { v: 1, challengeId: challenge.value.challengeId, proofB64 },
      SessionResponseSchema
    )
    if (!parsed.ok) {
      return this.remember(parsed, 'the push service refused this host')
    }
    if (parsed.value.hostFingerprint !== this.hostFingerprint) {
      // The gateway answered for some other host; that token is never usable here.
      return this.remember({ ok: false, reason: 'rejected' }, 'it answered for a different host')
    }
    this.session = { token: parsed.value.sessionToken, expiresAt: parsed.value.expiresAt }
    this.negative = null
    return this.signedIn(this.session)
  }

  private signedIn(session: PushSession): PushSessionOutcome {
    this.refusedClockSkewMs = null
    this.lastFailure = null
    if (this.loggedFailure !== null) {
      this.loggedFailure = null
      console.warn('[push] Signed in to the push service again')
    }
    return { ok: true, session }
  }

  private async handshakePost<TSchema extends z.ZodType>(
    path: string,
    body: unknown,
    schema: TSchema
  ): Promise<{ ok: true; value: z.infer<TSchema> } | PushGatewayFailure> {
    return await readPushGatewayJson(
      await postPushGatewayJson(this.fetchImpl, `${this.origin}${path}`, body),
      schema
    )
  }

  // A clock set back (the usual fix for skew) ends the cache instead of stretching it by the skew.
  private isCached(entry: { at: number; ttlMs: number }): boolean {
    const age = this.now() - entry.at
    return age >= 0 && age < entry.ttlMs
  }

  /** Caches refusals and 429s; a transport failure may clear on the very next try. */
  private remember(failure: PushGatewayFailure, cause: string): PushGatewayFailure {
    const problem = pushServiceProblemOf(failure)
    this.lastFailure = problem
    if (problem === 'rate_limited') {
      // Back off the per-IP challenge bucket instead of exhausting it on unusable sessions.
      this.negative = { at: this.now(), ttlMs: HANDSHAKE_RATE_LIMIT_TTL_MS, failure }
    } else if (problem === 'refused') {
      this.negative = { at: this.now(), ttlMs: HANDSHAKE_REFUSAL_TTL_MS, failure }
      this.refusedClockSkewMs = failure.clockSkewMs ?? null
    }
    // Clock refusals key on the cause without the seconds, which drift between attempts.
    const key =
      problem !== 'refused' ? problem : failure.clockSkewMs === undefined ? cause : 'clock'
    if (key !== this.loggedFailure) {
      this.loggedFailure = key
      console.warn(signInFailureMessage(problem, cause))
    }
    return failure
  }
}

function signInFailureMessage(problem: MobilePushServiceProblem, cause: string): string {
  switch (problem) {
    case 'refused':
      return `[push] Push service sign-in refused: ${cause}. Phones get no pushes from this host.`
    case 'rate_limited':
      return '[push] Push service rate limited sign-in (HTTP 429); retrying. Phones get no pushes from this host until it signs in.'
    case 'unreachable':
      return '[push] Push service unreachable for sign-in; retrying. Phones get no pushes from this host until it signs in.'
  }
}

function clockSkewCause(skewMs: number): string {
  const seconds = Math.round(Math.abs(skewMs) / 1000)
  return `this host's clock is ${seconds} s ${skewMs > 0 ? 'ahead of' : 'behind'} the push service; set the system clock (for example, turn on NTP)`
}
