import { randomUUID } from 'node:crypto'
import type { DeviceRegistry } from '../rpc/server/pairing/device-registry'
import type { PushGatewayClient, PushSendResult } from './push-gateway-client'
import type { MobilePushDeliveryMode } from './mobile-push-delivery-policy'
import type { MobilePushTestResult } from '../../../shared/notifications/mobile-push-contract'
import type { PushGatewayResult } from './push-gateway-response'

/** What the phone's "send test notification" reports for the gateway's answer to its one registration. */
export function pushTestResult(
  result: PushGatewayResult<{ results: readonly PushSendResult[] }>,
  registrationId: string
): MobilePushTestResult {
  if (!result.ok) {
    return {
      accepted: false,
      reason: result.reason === 'unreachable' ? 'unavailable' : 'rejected',
      ...clockSkew(result.clockSkewMs)
    }
  }
  const status = result.results.find((entry) => entry.registrationId === registrationId)?.status
  if (status === 'queued') {
    return { accepted: true }
  }
  return {
    accepted: false,
    reason:
      status === 'rate_limited' ? 'rate_limited' : status === 'dead' ? 'not_registered' : 'rejected'
  }
}

/** A wrong host clock blocks the sign-in registration needs, so the phone can say so. */
export function unregisteredTestResult(clockSkewMs: number | null): MobilePushTestResult {
  return { accepted: false, reason: 'not_registered', ...clockSkew(clockSkewMs ?? undefined) }
}

function clockSkew(skewMs: number | undefined): { clockSkewSeconds?: number } {
  return skewMs === undefined ? {} : { clockSkewSeconds: Math.round(skewMs / 1000) }
}

export async function sendPushTest(
  client: PushGatewayClient,
  registry: DeviceRegistry,
  deviceId: string,
  stopped: boolean,
  deliveryMode: MobilePushDeliveryMode
): Promise<MobilePushTestResult> {
  const device = registry.getDevice(deviceId)
  const registration = device?.pushRegistration
  if (device?.scope !== 'mobile' || !registration || registration.expiresAt <= Date.now()) {
    const live = !stopped && deliveryMode !== 'disabled'
    return unregisteredTestResult(live ? await client.currentClockSkewMs() : null)
  }
  if (stopped || deliveryMode === 'disabled') {
    return { accepted: false, reason: 'unavailable' }
  }
  // Explicit tests target only the caller and bypass automatic activity filters.
  const result = await client.send({
    registrationIds: [registration.registrationId],
    notification: {
      source: 'terminal-bell',
      agentState: null,
      title: 'Test notification',
      body: '',
      notificationId: randomUUID(),
      notificationEpoch: randomUUID(),
      notificationSeq: 0,
      expiresAt: Date.now() + 300_000,
      sound: registration.filter.sound !== false
    }
  })
  return pushTestResult(result, registration.registrationId)
}
