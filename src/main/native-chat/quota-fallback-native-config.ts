import { createHash } from 'node:crypto'
import {
  readVerifiedQuotaBilling,
  type NativeQuotaBillingProof
} from './quota-fallback-billing-proof'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { structuredAgentSessionMessageSendMutation } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { latestNativeChatTurnSinceRequest } from '../../shared/native-chat/native-chat-orca-stop-cut'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-host'
import type { ConfirmedQuotaCut } from './quota-fallback-journal-cut'
import type { NativeQuotaReservation } from './quota-fallback-native-store'
import { decideQuotaFallback, type QuotaFallbackCandidate } from './quota-fallback-policy'

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
  /** Minimum cooldown between re-verifying the same held session turn cut. */
  heldRetryIntervalMs?: number
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

export async function prepareQuotaContinuationReservation(input: {
  config: NativeQuotaFallbackConfig
  hostId: string
  record: AgentSessionRecord & { provider: 'claude' | 'codex' }
  cut: ConfirmedQuotaCut
  now: () => number
  isDisposed: () => boolean
}): Promise<
  | { kind: 'aborted' }
  | { kind: 'held'; outcome?: string }
  | { kind: 'ready'; reservation: NativeQuotaReservation; remainingUsd: number }
> {
  const verified = await readVerifiedQuotaBilling(
    input.config,
    { record: input.record, cut: input.cut },
    input.now
  )
  if (input.isDisposed()) {
    return { kind: 'aborted' }
  }
  if (!verified || !verified.billingProof) {
    return { kind: 'held', outcome: 'noVerifiedCreditCap' }
  }
  if (
    verified.candidates.some(
      (candidate) => candidate.route === 'antigravity-opus' && candidate.available
    )
  ) {
    reportQuotaOutcome(input.config, input.cut.sessionId, 'antigravityAdapterUnavailable')
  }
  const decision = decideQuotaFallback({
    enabled: true,
    provider: input.record.provider,
    billing: verified.billing,
    errorCode: input.cut.errorCode,
    turnId: input.cut.turnItemId,
    currentTurnId: input.cut.turnItemId,
    settled: true,
    pending: false,
    candidates: verified.candidates.filter((candidate) => candidate.route !== 'antigravity-opus'),
    now: input.now()
  })
  if (decision.kind === 'hold') {
    return { kind: 'held', outcome: decision.reason }
  }
  const candidate = verified.candidates.find((item) => item.route === decision.route)
  if (decision.route === 'antigravity-opus' || !candidate?.credit) {
    return { kind: 'held' }
  }
  const claimId = `quota-${createHash('sha256')
    .update(JSON.stringify([input.hostId, input.cut.sessionId, input.cut.turnItemId]))
    .digest('hex')}`
  const operationId = `${input.now()}-${claimId.slice(6, 38)}`
  return {
    kind: 'ready',
    remainingUsd: candidate.credit.remainingUsd,
    reservation: {
      operationId,
      claimId,
      credentialRef: verified.credentialRef,
      sessionId: input.cut.sessionId,
      sourceTurnId: input.cut.turnItemId,
      errorCode: input.cut.errorCode,
      route: decision.route,
      pool: verified.pool,
      maxDebitUsd: candidate.credit.maxDebitUsd,
      phase: 'reserved'
    }
  }
}

export function buildQuotaContinuationSendMutation(
  cut: ConfirmedQuotaCut,
  operationId: string,
  fence: number
) {
  return structuredAgentSessionMessageSendMutation({
    sessionId: cut.sessionId,
    clientOperationId: operationId,
    expectedRuntimeFence: fence,
    usageLimitContinuationOfTurnItemId: cut.turnItemId,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'Continue where you left off. Preserve existing approvals and do not repeat completed operations.'
        }
      ]
    }
  })
}

export function isQuotaContinuationSubmissionSettled(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  operationId: string,
  sourceTurnId: string
): boolean | null {
  const submission = submissions.find((value) => value.clientMessageId === operationId)
  if (
    !submission ||
    submission.dispatchState === 'pending' ||
    submission.dispatchState === 'unknown'
  ) {
    return null
  }
  const latest = latestNativeChatTurnSinceRequest(items, submissions)
  return (
    submission.dispatchState === 'rejected' ||
    Boolean(latest?.verdict && latest.turnItem.itemId !== sourceTurnId)
  )
}
