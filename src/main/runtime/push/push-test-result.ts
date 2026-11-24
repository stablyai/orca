import type { MobilePushTestResult } from '../../../shared/notifications/mobile-push-contract'
import type { PushGatewayResult } from './push-gateway-response'
import type { PushSendResult } from './push-gateway-client'

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
