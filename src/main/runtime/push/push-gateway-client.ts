// Return best-effort gateway outcomes instead of throwing through notification fan-out.
import { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import type { E2EEKeypair } from '../e2ee-keypair'
import type {
  MobilePushAgentState,
  MobilePushApnsEnvironment,
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
  kind?: 'alert' | 'dismiss'
  origin?: string
  occurrence?: string
  expiresAt?: number
  sound?: boolean
  notificationId?: string
  notificationSeq: number
  notificationEpoch: string
  source: MobilePushSource
  agentState: MobilePushAgentState | null
  title: string
  body: string
  worktreeId?: string
  paneKey?: string
  executionHost?: `runtime:${string}`
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

  constructor(options: PushGatewayClientOptions) {
    this.origin = new URL(options.gatewayUrl).origin
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.session = new PushGatewaySession({
      origin: this.origin,
      keypair: options.keypair,
      fetchImpl: this.fetchImpl,
      now: options.now ?? Date.now
    })
  }

  get gatewayOrigin(): string {
    return this.origin
  }

  async registerDevice(input: {
    routeKey?: string
    deviceId: string
    platform: MobilePushPlatform
    token: string
    apnsEnvironment?: MobilePushApnsEnvironment
  }): Promise<PushGatewayResult<{ registrationId: string }>> {
    const session = await this.session.ensure(null)
    if (!session.ok) {
      return session
    }
    const routeKey = this.session.supportsOriginClaims ? input.routeKey : undefined
    const body = {
      v: 1,
      deviceId: input.deviceId,
      platform: input.platform,
      token: input.token,
      ...(input.apnsEnvironment ? { apnsEnvironment: input.apnsEnvironment } : {}),
      ...(routeKey ? { routeKey } : {})
    }
    const response = await this.authorized('/v1/devices', {
      method: 'POST',
      body
    })
    let parsed = await readPushGatewayJson(response, RegisterResponseSchema)
    if (routeKey && this.refusedFields(parsed)) {
      const { routeKey: _key, ...stripped } = body
      parsed = await readPushGatewayJson(
        await this.authorized('/v1/devices', { method: 'POST', body: stripped }),
        RegisterResponseSchema
      )
      if (parsed.ok) {
        this.session.supportsOriginClaims = false
      }
    }
    return parsed.ok ? { ok: true, registrationId: parsed.value.registrationId } : parsed
  }

  async deleteDevice(registrationId: string): Promise<boolean> {
    const response = await this.authorized(`/v1/devices/${encodeURIComponent(registrationId)}`, {
      method: 'DELETE'
    })
    if (!response.ok) {
      return false
    }
    await cancelUnreadResponseBody(response.response)
    // A gateway that no longer knows the registration is as deleted as it gets.
    return response.response.ok || response.response.status === 404
  }

  async send(input: {
    registrationIds: readonly string[]
    notification: PushSendNotification
  }): Promise<PushGatewayResult<{ results: readonly PushSendResult[] }>> {
    const session = await this.session.ensure(null)
    if (!session.ok) {
      return session
    }
    const { origin, occurrence, ...legacy } = input.notification
    const stamped = { ...legacy, origin, occurrence }
    const notification =
      this.session.supportsOriginClaims &&
      origin &&
      occurrence &&
      Buffer.byteLength(JSON.stringify(stamped)) <= 3000
        ? stamped
        : legacy
    const response = await this.authorized('/v1/send', {
      method: 'POST',
      body: {
        v: 1,
        registrationIds: [...input.registrationIds],
        notification
      }
    })
    let parsed = await readPushGatewayJson(response, SendResponseSchema)
    if ('origin' in notification && this.refusedFields(parsed)) {
      parsed = await readPushGatewayJson(
        await this.authorized('/v1/send', {
          method: 'POST',
          body: { v: 1, registrationIds: [...input.registrationIds], notification: legacy }
        }),
        SendResponseSchema
      )
      if (parsed.ok) {
        this.session.supportsOriginClaims = false
      }
    }
    return parsed.ok ? { ok: true, results: parsed.value.results } : parsed
  }

  private refusedFields(result: PushGatewayFailure | { ok: true }): boolean {
    return (
      !result.ok &&
      result.reason === 'rejected' &&
      result.status !== undefined &&
      result.status >= 400 &&
      result.status < 500 &&
      result.status !== 401 &&
      result.status !== 429
    )
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
      // A 401 after fresh authentication means temporary gateway failure; preserve send retry and report register unreachable.
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
