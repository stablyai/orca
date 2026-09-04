// Why: talks to the Orca push gateway (docs/reference/mobile-push-contract.md).
// Every method returns a result instead of throwing — push is best-effort and
// must never break the socket fan-out it rides along with.
import { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import type { E2EEKeypair } from '../e2ee-keypair'
import { deriveRelayHostId } from '../relay/relay-http-client'
import type {
  MobilePushAgentState,
  MobilePushApnsEnvironment,
  MobilePushFilter,
  MobilePushPlatform,
  MobilePushSource
} from '../../../shared/mobile-push-contract'
import { answerPushHostChallenge, type PushHostChallenge } from './push-host-proof'

const PUSH_REQUEST_DEADLINE_MS = 15_000
// Re-auth a little early so a send never spends its one retry on a token that
// expired between the check and the request.
const SESSION_RENEWAL_MARGIN_MS = 60_000

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

const RegisterResponseSchema = z.object({ registrationId: z.string().min(1).max(512) })

const SendResponseSchema = z.object({
  results: z
    .array(
      z.object({
        registrationId: z.string().min(1).max(512),
        status: z.enum(['queued', 'dead', 'rate_limited', 'error'])
      })
    )
    .max(64)
})

export type PushSendResult = z.infer<typeof SendResponseSchema>['results'][number]

export type PushGatewayFailure = { ok: false; reason: 'unreachable' | 'rejected' }
export type PushGatewayResult<T> = ({ ok: true } & T) | PushGatewayFailure

export type PushSendNotification = {
  notificationId?: string
  notificationSeq: number
  notificationEpoch: string
  source: MobilePushSource
  agentState: MobilePushAgentState | null
  title: string
  body: string
  worktreeId?: string
}

type PushGatewayClientOptions = {
  gatewayUrl: string
  keypair: E2EEKeypair
  fetch?: typeof globalThis.fetch
  now?: () => number
}

type CachedSession = { token: string; expiresAt: number }

export class PushGatewayClient {
  private readonly origin: string
  private readonly keypair: E2EEKeypair
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number
  readonly hostFingerprint: string
  private session: CachedSession | null = null
  private pendingSession: Promise<CachedSession | null> | null = null

  constructor(options: PushGatewayClientOptions) {
    this.origin = new URL(options.gatewayUrl).origin
    this.keypair = options.keypair
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.hostFingerprint = deriveRelayHostId(options.keypair.publicKey)
  }

  async registerDevice(input: {
    deviceId: string
    platform: MobilePushPlatform
    token: string
    apnsEnvironment?: MobilePushApnsEnvironment
    filter: MobilePushFilter
  }): Promise<PushGatewayResult<{ registrationId: string }>> {
    const response = await this.authorized('/v1/devices', {
      method: 'POST',
      body: {
        v: 1,
        deviceId: input.deviceId,
        platform: input.platform,
        token: input.token,
        ...(input.apnsEnvironment ? { apnsEnvironment: input.apnsEnvironment } : {}),
        filter: { sources: [...input.filter.sources], agentStates: [...input.filter.agentStates] }
      }
    })
    const parsed = await readJson(response, RegisterResponseSchema)
    return parsed.ok ? { ok: true, registrationId: parsed.value.registrationId } : parsed
  }

  /** `retryable` tells the outbox whether to keep the delete queued. */
  async deleteDevice(registrationId: string): Promise<{ deleted: boolean; retryable: boolean }> {
    const response = await this.authorized(`/v1/devices/${encodeURIComponent(registrationId)}`, {
      method: 'DELETE'
    })
    if (!response.ok) {
      return { deleted: false, retryable: response.reason === 'unreachable' }
    }
    await cancelUnreadResponseBody(response.response)
    // A gateway that no longer knows the registration is as deleted as it gets.
    const gone = response.response.ok || response.response.status === 404
    return { deleted: gone, retryable: !gone }
  }

  async send(input: {
    registrationIds: readonly string[]
    notification: PushSendNotification
  }): Promise<PushGatewayResult<{ results: readonly PushSendResult[] }>> {
    const response = await this.authorized('/v1/send', {
      method: 'POST',
      body: {
        v: 1,
        registrationIds: [...input.registrationIds],
        notification: input.notification
      }
    })
    const parsed = await readJson(response, SendResponseSchema)
    return parsed.ok ? { ok: true, results: parsed.value.results } : parsed
  }

  private async authorized(
    path: string,
    init: { method: string; body?: unknown }
  ): Promise<{ ok: true; response: Response } | PushGatewayFailure> {
    const first = await this.sendAuthorized(path, init, false)
    // A 401 means the cached session died server-side; one forced re-auth, then give up.
    if (first.ok && first.response.status === 401) {
      await cancelUnreadResponseBody(first.response)
      this.session = null
      return await this.sendAuthorized(path, init, true)
    }
    return first
  }

  private async sendAuthorized(
    path: string,
    init: { method: string; body?: unknown },
    forceReauth: boolean
  ): Promise<{ ok: true; response: Response } | PushGatewayFailure> {
    const session = await this.ensureSession(forceReauth)
    if (!session) {
      return { ok: false, reason: 'unreachable' }
    }
    try {
      const response = await this.fetchImpl(`${this.origin}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${session.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        signal: AbortSignal.timeout(PUSH_REQUEST_DEADLINE_MS),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
      })
      return { ok: true, response }
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
  }

  private async ensureSession(forceReauth: boolean): Promise<CachedSession | null> {
    if (forceReauth) {
      this.session = null
    }
    const cached = this.session
    if (cached && cached.expiresAt - SESSION_RENEWAL_MARGIN_MS > this.now()) {
      return cached
    }
    // Concurrent sends must not each burn a challenge; share one handshake.
    this.pendingSession ??= this.openSession().finally(() => {
      this.pendingSession = null
    })
    return await this.pendingSession
  }

  private async openSession(): Promise<CachedSession | null> {
    const challenge = await this.requestChallenge()
    if (!challenge) {
      return null
    }
    const proofB64 = answerPushHostChallenge(challenge, {
      gatewayOrigin: this.origin,
      hostFingerprint: this.hostFingerprint,
      hostPublicKey: this.keypair.publicKey,
      hostSecretKey: this.keypair.secretKey,
      now: this.now
    })
    if (!proofB64) {
      return null
    }
    const response = await this.post('/v1/host/session', {
      v: 1,
      challengeId: challenge.challengeId,
      proofB64
    })
    const parsed = await readJson(response, SessionResponseSchema)
    if (!parsed.ok || parsed.value.hostFingerprint !== this.hostFingerprint) {
      return null
    }
    this.session = { token: parsed.value.sessionToken, expiresAt: parsed.value.expiresAt }
    return this.session
  }

  private async requestChallenge(): Promise<PushHostChallenge | null> {
    const response = await this.post('/v1/host/challenge', {
      v: 1,
      hostPublicKeyB64: this.keypair.publicKeyB64
    })
    const parsed = await readJson(response, ChallengeResponseSchema)
    return parsed.ok ? parsed.value : null
  }

  private async post(
    path: string,
    body: unknown
  ): Promise<{ ok: true; response: Response } | PushGatewayFailure> {
    try {
      const response = await this.fetchImpl(`${this.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(PUSH_REQUEST_DEADLINE_MS),
        body: JSON.stringify(body)
      })
      return { ok: true, response }
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
  }
}

async function readJson<TSchema extends z.ZodType>(
  result: { ok: true; response: Response } | PushGatewayFailure,
  schema: TSchema
): Promise<{ ok: true; value: z.infer<TSchema> } | PushGatewayFailure> {
  if (!result.ok) {
    return result
  }
  const { response } = result
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    // 5xx and 429 are worth another attempt later; anything else is the gateway
    // refusing this request as written.
    return {
      ok: false,
      reason: response.status >= 500 || response.status === 429 ? 'unreachable' : 'rejected'
    }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    await cancelUnreadResponseBody(response)
    return { ok: false, reason: 'unreachable' }
  }
  const parsed = schema.safeParse(payload)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'rejected' }
}
