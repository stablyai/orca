import { createHash } from 'node:crypto'
import { PUSH_DEFAULTS, PUSH_LIMITS } from '@orca-cloud/push-contract'
import { orcaDataStrings, type PushDelivery } from './push-delivery-message.js'
import type { PushProviderOutcome } from './push-provider-outcome.js'

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

export type FcmRequest = { url: string; accessToken: string; body: string }
export type FcmResponse = { status: number; body: string }
export type FcmTransport = (request: FcmRequest) => Promise<FcmResponse>

export type FcmClientOptions = {
  projectId: string
  accessToken: () => Promise<string>
  transport: FcmTransport
  channelId?: string
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
  validateOnly?: boolean
}): string {
  const { delivery } = input
  return JSON.stringify({
    ...(input.validateOnly ? { validate_only: true } : {}),
    message: {
      token: input.token,
      notification: { title: delivery.title, body: delivery.body },
      android: {
        priority: 'HIGH',
        ttl: `${PUSH_LIMITS.notificationTtlSeconds}s`,
        collapse_key: fcmCollapseKey(delivery.collapseId),
        notification: { channel_id: input.channelId, tag: delivery.collapseId }
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

  async send(
    delivery: PushDelivery,
    device: { token: string },
    options: { validateOnly?: boolean } = {}
  ): Promise<PushProviderOutcome> {
    let response: FcmResponse
    try {
      response = await this.options.transport({
        url: `https://fcm.googleapis.com/v1/projects/${this.options.projectId}/messages:send`,
        accessToken: await this.options.accessToken(),
        body: fcmMessageBody({
          delivery,
          token: device.token,
          channelId: this.channelId,
          ...(options.validateOnly === undefined ? {} : { validateOnly: options.validateOnly })
        })
      })
    } catch (error) {
      return { status: 'error', reason: error instanceof Error ? error.name : 'transport_failed' }
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
    return { status: 'error', reason: failure.status }
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
      signal: AbortSignal.timeout(10_000)
    })
    return { status: response.status, body: await response.text() }
  }
}
