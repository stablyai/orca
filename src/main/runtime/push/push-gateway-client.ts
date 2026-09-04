// Why: talks to the Orca push gateway (docs/reference/mobile-push-contract.md).
// Every method returns a result instead of throwing — push is best-effort and
// must never break the socket fan-out it rides along with.
import { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import type { E2EEKeypair } from '../e2ee-keypair'
import type {
  MobilePushAgentState,
  MobilePushApnsEnvironment,
  MobilePushFilter,
  MobilePushPlatform,
  MobilePushSource
} from '../../../shared/mobile-push-contract'
import {
  PUSH_REQUEST_DEADLINE_MS,
  readPushGatewayJson,
  type PushGatewayFailure,
  type PushGatewayResponse,
  type PushGatewayResult
} from './push-gateway-response'
import { PushGatewaySession } from './push-gateway-session'

export type { PushGatewayFailure, PushGatewayResult }

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

type AuthorizedResponse = { ok: true; response: Response; token: string } | PushGatewayFailure

export class PushGatewayClient {
  private readonly origin: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly session: PushGatewaySession
  readonly hostFingerprint: string

  constructor(options: PushGatewayClientOptions) {
    this.origin = new URL(options.gatewayUrl).origin
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.session = new PushGatewaySession({
      origin: this.origin,
      keypair: options.keypair,
      fetchImpl: this.fetchImpl,
      now: options.now ?? Date.now
    })
    this.hostFingerprint = this.session.hostFingerprint
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
    const parsed = await readPushGatewayJson(response, RegisterResponseSchema)
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
    const parsed = await readPushGatewayJson(response, SendResponseSchema)
    return parsed.ok ? { ok: true, results: parsed.value.results } : parsed
  }

  private async authorized(
    path: string,
    init: { method: string; body?: unknown }
  ): Promise<PushGatewayResponse> {
    const first = await this.sendAuthorized(path, init, null)
    if (!first.ok || first.response.status !== 401) {
      return first
    }
    // A 401 means that one session died server-side; one forced re-auth, then stop.
    await cancelUnreadResponseBody(first.response)
    const retried = await this.sendAuthorized(path, init, first.token)
    if (retried.ok && retried.response.status === 401) {
      await cancelUnreadResponseBody(retried.response)
      // A 401 that survives a freshly minted session is the gateway being unusable
      // right now, not this request being wrong: register should report it as
      // unreachable, and send should still spend its one retry.
      return { ok: false, reason: 'unreachable' }
    }
    return retried
  }

  private async sendAuthorized(
    path: string,
    init: { method: string; body?: unknown },
    staleToken: string | null
  ): Promise<AuthorizedResponse> {
    const outcome = await this.session.ensure(staleToken)
    if (!outcome.ok) {
      return outcome
    }
    try {
      const response = await this.fetchImpl(`${this.origin}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${outcome.session.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        redirect: 'error',
        signal: AbortSignal.timeout(PUSH_REQUEST_DEADLINE_MS),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
      })
      return { ok: true, response, token: outcome.session.token }
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
  }
}
