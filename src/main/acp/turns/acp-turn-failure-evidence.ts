import { providerDiagnostic } from '../../../shared/agent-session/failures/agent-session-failure'
import type { AgentSessionUsageLimit } from '../../../shared/agent-session/failures/agent-session-usage-limit'
import type { AcpTurnEnding } from '../acp-dialects/acp-dialect'

const FAILED_STOP_REASONS = ['error', 'rate_limit']

export function acpStopReasonFailed(stopReason: string): boolean {
  return FAILED_STOP_REASONS.includes(stopReason)
}

export type AcpTurnFailureReport = Pick<
  AcpTurnEnding,
  | 'stopReason'
  | 'failureDetail'
  | 'notSignedIn'
  | 'modelNotSelected'
  | 'usageLimit'
  | 'providerFailure'
>

export type AcpTurnFailureEvidence = {
  text: string
  notSignedIn: boolean
  modelNotSelected?: boolean
  usageLimited: boolean
  providerFailure: boolean
  usageLimit?: AgentSessionUsageLimit
}

/** Keep the first diagnostic and established causes when a later RPC error is generic. */
export function mergeAcpTurnFailureEvidence(
  previous: AcpTurnFailureEvidence | undefined,
  {
    stopReason,
    failureDetail: text,
    notSignedIn,
    modelNotSelected,
    usageLimit,
    providerFailure
  }: AcpTurnFailureReport
): AcpTurnFailureEvidence {
  const authenticationRequired = notSignedIn === true || previous?.notSignedIn === true
  return {
    text:
      previous?.text ||
      (text === undefined ? '' : (providerDiagnostic(text, 'person')?.text ?? '')),
    notSignedIn: authenticationRequired,
    modelNotSelected: modelNotSelected === true || previous?.modelNotSelected === true,
    usageLimited:
      !authenticationRequired && (stopReason === 'rate_limit' || previous?.usageLimited === true),
    providerFailure: providerFailure === true || previous?.providerFailure === true,
    usageLimit: usageLimit ?? previous?.usageLimit
  }
}

/** Agents report their own refusals as errors too; only these causes make a failure the provider's. */
export function acpProviderFailed(evidence: AcpTurnFailureEvidence): boolean {
  return (
    evidence.notSignedIn ||
    evidence.modelNotSelected === true ||
    evidence.usageLimited ||
    evidence.providerFailure
  )
}
