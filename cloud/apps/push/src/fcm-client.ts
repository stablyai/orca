import { providerRetryAfter } from './provider-retry-delay.js'
import { createHash } from 'node:crypto'
import { PUSH_DEFAULTS } from '@orca-cloud/push-contract'
import { orcaDataStrings, type PushDelivery } from './push-delivery-message.js'
import type { PushProviderOutcome } from './push-provider-outcome.js'

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

export type FcmRequest = { url: string; accessToken: string; body: string }
export type FcmResponse = { status: number; body: string; retryAfterMs?: number }
export type FcmTransport = (request: FcmRequest) => Promise<FcmResponse>

export type FcmClientOptions = {
  projectId: string
  accessToken: () => Promise<string>
  transport: FcmTransport
  channelId?: string
  now?: () => number
}

type FcmErrorBody = {
  error?: { status?: unknown; message?: unknown; details?: { errorCode?: unknown }[] }
}

// FCM collapse_key is a short opaque string, so the collapse id is hashed
// rather than truncated: truncation would merge unrelated notifications.
export function fcmCollapseKey(collapseId: string): string {
  return createHash('sha256').update(collapseId).digest('hex').slice(0, 32)
}

export function fcmMessageBody(input: {
  delivery: PushDelivery
  token: string
  channelId: string
  now?: number
}): string {
  const { delivery } = input
  const now = input.now ?? Date.now()
  return JSON.stringify({
    message: {
      token: input.token,
      ...(delivery.orca.kind === 'dismiss'
        ? {}
        : { notification: { title: delivery.title, body: delivery.body } }),
      android: {
        priority: 'HIGH',
        ttl: `${Math.max(0, Math.ceil((delivery.expiresAt - now) / 1000))}s`,
        collapse_key: fcmCollapseKey(delivery.collapseId),
        ...(delivery.orca.kind === 'dismiss'
          ? {}
          : {
              notification: {
                channel_id:
                  delivery.sound === false ? `${input.channelId}-silent` : input.channelId,
                tag: delivery.collapseId
              }
            })
      },
      data: orcaDataStrings(delivery.orca)
    }
  })
}

function readFcmError(body: string): { status: string; message: string; errorCodes: string[] } {
  try {
    const parsed = JSON.parse(body) as FcmErrorBody
    return {
      status: typeof parsed.error?.status === 'string' ? parsed.error.status : 'unknown',
      message: typeof parsed.error?.message === 'string' ? parsed.error.message : '',
      errorCodes: (parsed.error?.details ?? [])
        .map((detail) => detail.errorCode)
        .filter((code): code is string => typeof code === 'string')
    }
  } catch {
    return { status: 'unparseable', message: '', errorCodes: [] }
  }
}

export class FcmClient {
  private readonly channelId: string

  constructor(private readonly options: FcmClientOptions) {
    this.channelId = options.channelId ?? PUSH_DEFAULTS.androidChannelId
  }

  async send(delivery: PushDelivery, device: { token: string }): Promise<PushProviderOutcome> {
    if (delivery.expiresAt <= (this.options.now ?? Date.now)())
      return { status: 'error', reason: 'expired' }
    let response: FcmResponse
    try {
      const accessToken = await this.options.accessToken()
      const now = (this.options.now ?? Date.now)()
      if (delivery.expiresAt <= now) return { status: 'error', reason: 'expired' }
      response = await this.options.transport({
        url: `https://fcm.googleapis.com/v1/projects/${this.options.projectId}/messages:send`,
        accessToken,
        body: fcmMessageBody({
          delivery,
          token: device.token,
          channelId: this.channelId,
          now
        })
      })
    } catch (error) {
      return {
        status: 'error',
        reason: error instanceof Error ? error.name : 'transport_failed',
        retryable: true
      }
    }
    if (response.status >= 200 && response.status < 300) return { status: 'sent' }
    const failure = readFcmError(response.body)
    if (failure.status === 'UNREGISTERED' || failure.errorCodes.includes('UNREGISTERED')) {
      return { status: 'dead', reason: 'UNREGISTERED' }
    }
    // A revoked token also surfaces as INVALID_ARGUMENT naming the token field.
    if (failure.status === 'INVALID_ARGUMENT' && /\btoken\b/i.test(failure.message)) {
      return { status: 'dead', reason: 'INVALID_ARGUMENT' }
    }
    return {
      status: 'error',
      reason: failure.status,
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: Math.max(response.status === 429 ? 60_000 : 10_000, response.retryAfterMs ?? 0)
    }
  }
}

export function createFcmFetchTransport(fetchImpl: typeof fetch = fetch): FcmTransport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.accessToken}`,
        'content-type': 'application/json'
      },
      body: request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
    return {
      status: response.status,
      body: await response.text(),
      retryAfterMs: providerRetryAfter(response.headers.get('retry-after') ?? undefined)
    }
  }
}
