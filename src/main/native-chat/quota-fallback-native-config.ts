import type { NativeQuotaBillingProof } from './quota-fallback-billing-proof'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-host'
import type { ConfirmedQuotaCut } from './quota-fallback-journal-cut'
import type { QuotaFallbackCandidate } from './quota-fallback-policy'
export type NativeQuotaFallbackConfig = {
  enabled: boolean
  /** Verification must be host/account/model-specific, fresh, and prove a provider-side debit cap. */
  verify(input: { record: AgentSessionRecord; cut: ConfirmedQuotaCut }): Promise<{
    billing: 'subscription' | 'api'
    pool: string
    credentialRef: string
    candidates: readonly QuotaFallbackCandidate[]
    billingProof: NativeQuotaBillingProof | null
  } | null>
  readApiKey(
    route: 'claude-api' | 'openai-api',
    account: { pool: string; credentialRef: string }
  ): Promise<string>
  report?(sessionId: string, outcome: string): void
}

export type NativeQuotaHost = Pick<
  StructuredAgentSessionHost,
  | 'deps'
  | 'quotaContinuation'
  | 'send'
  | 'journalSnapshot'
  | 'observeJournalPublications'
  | 'currentWork'
>

export function reportQuotaOutcome(
  config: NativeQuotaFallbackConfig | undefined,
  sessionId: string,
  outcome: string
): void {
  try {
    config?.report?.(sessionId, outcome)
  } catch {
    /* Reporting cannot change ownership. */
  }
}
