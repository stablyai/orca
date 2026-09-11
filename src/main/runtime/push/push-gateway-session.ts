// Why: the challenge/proof handshake every push request rides on, split out of
// push-gateway-client.ts so the session cache and its refusal cache stay readable
// next to the request methods rather than buried under them.
import { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import type { E2EEKeypair } from '../e2ee-keypair'
import { deriveRelayHostId } from '../relay/relay-http-client'
import { answerPushHostChallenge } from './push-host-proof'
import {
  postPushGatewayJson,
  readPushGatewayJson,
  type PushGatewayFailure
} from './push-gateway-response'

// Re-auth a little early so a send never spends its one retry on a token that
// expired between the check and the request.
const SESSION_RENEWAL_MARGIN_MS = 60_000
// Why: a gateway that refuses this host's proof refuses the identical next one,
// so without this every dispatch pays two full handshake round trips to relearn it.
const HANDSHAKE_REFUSAL_TTL_MS = 30_000
// Why: the handshake routes sit behind a per-IP bucket. Backing off keeps this
// host from spending the whole bucket on challenges it will never get to use.
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
  private negative: { until: number; reason: PushGatewayFailure['reason'] } | null = null

  constructor(options: PushGatewaySessionOptions) {
    this.origin = options.origin
    this.keypair = options.keypair
    this.fetchImpl = options.fetchImpl
    this.now = options.now
    this.hostFingerprint = deriveRelayHostId(options.keypair.publicKey)
  }

  /**
   * `staleToken` is the token that just received a 401. Only that exact session is
   * dropped: a concurrent request may already have installed a good one, and
   * clearing unconditionally would throw it away and re-handshake for nothing.
   */
  async ensure(staleToken: string | null): Promise<PushSessionOutcome> {
    if (staleToken !== null && this.session?.token === staleToken) {
      this.session = null
    }
    const cached = this.session
    if (cached && cached.expiresAt - SESSION_RENEWAL_MARGIN_MS > this.now()) {
      return { ok: true, session: cached }
    }
    if (this.negative && this.negative.until > this.now()) {
      return { ok: false, reason: this.negative.reason }
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
      return this.remember(challenge)
    }
    const proofB64 = answerPushHostChallenge(challenge.value, {
      gatewayOrigin: this.origin,
      hostFingerprint: this.hostFingerprint,
      hostPublicKey: this.keypair.publicKey,
      hostSecretKey: this.keypair.secretKey,
      now: this.now
    })
    if (!proofB64) {
      // A challenge this host cannot answer is a refusal, not a dropped packet.
      return this.remember({ ok: false, reason: 'rejected' })
    }
    const parsed = await this.handshakePost(
      '/v1/host/session',
      { v: 1, challengeId: challenge.value.challengeId, proofB64 },
      SessionResponseSchema
    )
    if (!parsed.ok) {
      return this.remember(parsed)
    }
    if (parsed.value.hostFingerprint !== this.hostFingerprint) {
      // The gateway answered for some other host; that token is never usable here.
      return this.remember({ ok: false, reason: 'rejected' })
    }
    this.session = { token: parsed.value.sessionToken, expiresAt: parsed.value.expiresAt }
    this.negative = null
    return { ok: true, session: this.session }
  }

  private async handshakePost<TSchema extends z.ZodType>(
    path: string,
    body: unknown,
    schema: TSchema
  ): Promise<{ ok: true; value: z.infer<TSchema> } | PushGatewayFailure> {
    const response = await postPushGatewayJson(this.fetchImpl, `${this.origin}${path}`, body)
    if (response.ok && response.response.status === 429) {
      await cancelUnreadResponseBody(response.response)
      // Rate limiting refuses the moment, not this host: back off, stay retryable
      // so register reports gateway_unreachable and send keeps its one retry.
      this.negative = { until: this.now() + HANDSHAKE_RATE_LIMIT_TTL_MS, reason: 'unreachable' }
      return { ok: false, reason: 'unreachable' }
    }
    return await readPushGatewayJson(response, schema)
  }

  /** Caches refusals only: a transport failure may clear on the very next try. */
  private remember(failure: PushGatewayFailure): PushGatewayFailure {
    if (failure.reason === 'rejected') {
      this.negative = { until: this.now() + HANDSHAKE_REFUSAL_TTL_MS, reason: 'rejected' }
    }
    return failure
  }
}
