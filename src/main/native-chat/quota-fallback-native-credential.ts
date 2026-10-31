import { readVerifiedQuotaBilling } from './quota-fallback-billing-proof'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { NativeQuotaFallbackConfig } from './quota-fallback-native-config'
import type { NativeQuotaReservation } from './quota-fallback-native-store'
import type { NativeQuotaApiCredential } from './quota-fallback-native-auth'
import type { ConfirmedQuotaCut } from './quota-fallback-journal-cut'
import { decideQuotaFallback } from './quota-fallback-policy'

export async function verifyNativeQuotaCredential(
  config: NativeQuotaFallbackConfig,
  record: AgentSessionRecord,
  entry: NativeQuotaReservation,
  now: () => number,
  assertCurrent: () => void
): Promise<NativeQuotaApiCredential> {
  const cut: ConfirmedQuotaCut = {
    sessionId: entry.sessionId,
    turnItemId: entry.sourceTurnId,
    errorCode: entry.errorCode
  }
  const verified = await readVerifiedQuotaBilling(config, { record, cut }, now)
  const candidate = verified?.candidates.find((value) => value.route === entry.route)
  if (
    !verified?.billingProof ||
    verified.pool !== entry.pool ||
    verified.credentialRef !== entry.credentialRef ||
    !candidate?.credit ||
    candidate.credit.maxDebitUsd !== entry.maxDebitUsd
  ) {
    throw new Error('Quota credit cap no longer verified')
  }
  const decision = decideQuotaFallback({
    enabled: true,
    provider: entry.route === 'claude-api' ? 'claude' : 'codex',
    billing: verified.billing,
    errorCode: entry.errorCode,
    turnId: entry.sourceTurnId,
    currentTurnId: entry.sourceTurnId,
    settled: true,
    pending: false,
    candidates: [candidate],
    now: now()
  })
  if (decision.kind !== 'switch' || decision.route !== entry.route) {
    throw new Error('Quota credit is unavailable')
  }
  const apiKey = await config.readApiKey(entry.route, {
    pool: entry.pool,
    credentialRef: entry.credentialRef
  })
  assertCurrent()
  const fresh = decideQuotaFallback({
    enabled: true,
    provider: entry.route === 'claude-api' ? 'claude' : 'codex',
    billing: verified.billing,
    errorCode: entry.errorCode,
    turnId: entry.sourceTurnId,
    currentTurnId: entry.sourceTurnId,
    settled: true,
    pending: false,
    candidates: [candidate],
    now: now()
  })
  if (fresh.kind !== 'switch' || fresh.route !== entry.route || !apiKey || /[\r\n]/.test(apiKey)) {
    throw new Error('Quota API credential unavailable')
  }
  return { route: entry.route, apiKey, maxDebitUsd: entry.maxDebitUsd }
}
