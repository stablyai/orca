import type { ApnsEnvironment } from '@orca-cloud/push-contract/device-registration-messages'
import { ApnsAuthenticationToken } from './apns-authentication-token.js'
import type { ApnsTransport } from './apns-http2-transport.js'
import type { ApnsCredentials } from '../../config.js'
import type { PushDelivery } from '../../delivery/push-delivery-message.js'
import type { PushProviderOutcome } from '../push-provider-outcome.js'

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com'
}

const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered'])

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
  // No orca data: an app that predates badges has nothing to present in the foreground.
  if (delivery.orca.kind === 'badge') {
    return JSON.stringify({ aps: { badge: delivery.badge ?? 0 } })
  }
  return JSON.stringify({
    aps:
      delivery.orca.kind === 'dismiss'
        ? { 'content-available': 1 }
        : {
            alert: { title: delivery.title, body: delivery.body },
            ...(delivery.badge === undefined ? {} : { badge: delivery.badge }),
            ...(delivery.sound === false ? {} : { sound: 'default' }),
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
    const expiration = Math.floor(delivery.expiresAt / 1000)
    if (expiration * 1000 <= this.now()) return { status: 'error', reason: 'expired' }
    let response
    try {
      response = await this.options.transport({
        host: APNS_HOSTS[device.apnsEnvironment],
        path: `/3/device/${device.token}`,
        headers: {
          authorization: `bearer ${this.authentication.value()}`,
          'apns-topic': this.options.topic,
          'apns-push-type': delivery.orca.kind === 'dismiss' ? 'background' : 'alert',
          'apns-priority': delivery.orca.kind === 'dismiss' ? '5' : '10',
          // Never stored: APNs keeps one push per app for an offline phone, and a badge must not displace an alert.
          'apns-expiration': delivery.orca.kind === 'badge' ? '0' : String(expiration),
          ...(delivery.orca.kind === 'alert' || delivery.orca.kind === undefined
            ? { 'apns-collapse-id': delivery.collapseId }
            : {})
        },
        body: apnsBody(delivery)
      })
    } catch (error) {
      return {
        status: 'error',
        reason: error instanceof Error ? error.name : 'transport_failed',
        retryable: true
      }
    }
    if (response.status === 200) return { status: 'sent' }
    const reason = readReason(response.body)
    if (response.status === 410) return { status: 'dead', reason }
    if (response.status === 400 && DEAD_TOKEN_REASONS.has(reason)) {
      return { status: 'dead', reason }
    }
    return {
      status: 'error',
      reason,
      retryable: response.status === 429 || response.status >= 500,
      ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs })
    }
  }
}
