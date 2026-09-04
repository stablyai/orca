import { PUSH_LIMITS, type ApnsEnvironment } from '@orca-cloud/push-contract'
import { ApnsAuthenticationToken } from './apns-authentication-token.js'
import type { ApnsTransport } from './apns-http2-transport.js'
import type { ApnsCredentials } from './config.js'
import type { PushDelivery } from './push-delivery-message.js'
import type { PushProviderOutcome } from './push-provider-outcome.js'

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com'
}

const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'])

export type ApnsClientOptions = {
  topic: string
  credentials: ApnsCredentials
  transport: ApnsTransport
  now?: () => number
}

function readReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown }
    return typeof parsed.reason === 'string' ? parsed.reason : 'unknown'
  } catch {
    return 'unparseable'
  }
}

export function apnsBody(delivery: PushDelivery): string {
  return JSON.stringify({
    aps: {
      alert: { title: delivery.title, body: delivery.body },
      sound: 'default',
      'thread-id': delivery.hostFingerprint
    },
    orca: delivery.orca
  })
}

export class ApnsClient {
  private readonly authentication: ApnsAuthenticationToken
  private readonly now: () => number

  constructor(private readonly options: ApnsClientOptions) {
    this.now = options.now ?? Date.now
    this.authentication = new ApnsAuthenticationToken(options.credentials, this.now)
  }

  async send(
    delivery: PushDelivery,
    device: { token: string; apnsEnvironment: ApnsEnvironment }
  ): Promise<PushProviderOutcome> {
    const expiration = Math.floor(this.now() / 1000) + PUSH_LIMITS.notificationTtlSeconds
    let response
    try {
      response = await this.options.transport({
        host: APNS_HOSTS[device.apnsEnvironment],
        path: `/3/device/${device.token}`,
        headers: {
          authorization: `bearer ${this.authentication.value()}`,
          'apns-topic': this.options.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(expiration),
          'apns-collapse-id': delivery.collapseId
        },
        body: apnsBody(delivery)
      })
    } catch (error) {
      return { status: 'error', reason: error instanceof Error ? error.name : 'transport_failed' }
    }
    if (response.status === 200) return { status: 'sent' }
    const reason = readReason(response.body)
    if (response.status === 410) return { status: 'dead', reason }
    if (response.status === 400 && DEAD_TOKEN_REASONS.has(reason)) {
      return { status: 'dead', reason }
    }
    return { status: 'error', reason }
  }
}
