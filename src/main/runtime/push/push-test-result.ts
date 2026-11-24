import type { MobilePushTestResult } from '../../../shared/notifications/mobile-push-contract'
import { pushServiceProblemOf, type PushGatewayResult } from './push-gateway-response'
import type { PushSendResult, PushSignInProblem } from './push-gateway-client'

/** What the phone's "send test notification" reports for the gateway's answer to its one registration. */
export function pushTestResult(
  result: PushGatewayResult<{ results: readonly PushSendResult[] }>,
  registrationId: string
): MobilePushTestResult {
  if (!result.ok) {
    return {
      accepted: false,
      reason: result.reason === 'unreachable' ? 'unavailable' : 'rejected',
      pushServiceProblem: pushServiceProblemOf(result),
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

/** A push service that refuses or rate limits sign-in blocks the registration, so the phone can say why. */
export function unregisteredTestResult(signIn: PushSignInProblem | null): MobilePushTestResult {
  return {
    accepted: false,
    reason: 'not_registered',
    ...(signIn ? { pushServiceProblem: signIn.problem } : {}),
    ...clockSkew(signIn?.clockSkewMs)
  }
}

function clockSkew(skewMs: number | undefined): { clockSkewSeconds?: number } {
  return skewMs === undefined ? {} : { clockSkewSeconds: Math.round(skewMs / 1000) }
}
