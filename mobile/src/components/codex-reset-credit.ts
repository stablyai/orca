import { formatResetDuration } from '../../../src/shared/rate-limit-reset-format'
import {
  buildCodexResetCreditExpectedScope,
  type CodexResetCreditExpectedScope
} from '../../../src/shared/codex-reset-credit-scope'
import type { RpcClient } from '../transport/rpc-client'
import {
  clearCodexResetAttemptAfterAuthoritativeResponse,
  CodexResetCreditExpectedScopeSchema,
  getCodexResetAttemptIdentityKey,
  getOrCreateCodexResetAttempt
} from '../storage/codex-reset-attempt-journal'
import {
  decodeAccountsSnapshot,
  type AccountsSnapshot,
  type ProviderRateLimits
} from './accounts-snapshot'
import { t } from '@/i18n/mobile-i18n'

export type CodexResetCreditOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'

export type CodexResetCreditRejectedBeforeProviderReason =
  | 'targetChanged'
  | 'accountChanged'
  | 'accountRevisionChanged'
  | 'accountRuntimeChanged'
  | 'offerUnavailable'
  | 'offerChanged'

export type CodexResetCreditConsumedRpcResult = {
  outcome: CodexResetCreditOutcome
  scope: CodexResetCreditExpectedScope
  snapshot: AccountsSnapshot
}

export type CodexResetCreditRejectedRpcResult = {
  status: 'rejectedBeforeProvider'
  retryDisposition: 'discardAttempt'
  reason: CodexResetCreditRejectedBeforeProviderReason
  scope: CodexResetCreditExpectedScope
  snapshot: AccountsSnapshot
}

export type CodexResetCreditRpcResult =
  | CodexResetCreditConsumedRpcResult
  | CodexResetCreditRejectedRpcResult

export type CodexResetCreditRequestResult = CodexResetCreditRpcResult & {
  // A valid host result remains authoritative even if local cleanup fails.
  // The retained UUID makes a later retry idempotent instead of hiding success.
  attemptJournalRetained: boolean
}

export type CodexResetCreditSummary = {
  availableCount: number
  availabilityLabel: string
  expiryLabel: string | null
}

const RESET_RPC_TIMEOUT_MS = 90_000
const resetRequests = new Map<string, Promise<CodexResetCreditRequestResult>>()

export function getCodexResetCreditSummary(
  limits: ProviderRateLimits | null,
  now: number
): CodexResetCreditSummary | null {
  const credits = limits?.rateLimitResetCredits
  const count = credits?.availableCount ?? 0
  if (!Number.isInteger(count) || count <= 0) {
    return null
  }
  const expiry = credits?.nextExpiresAt
  let expiryLabel: string | null = null
  if (typeof expiry === 'number' && Number.isFinite(expiry)) {
    const duration = formatResetDuration(expiry - now)
    expiryLabel =
      count === 1
        ? duration === 'now'
          ? t('codexResetCredit.expiresNow')
          : t('codexResetCredit.expiresDuration', { duration: duration })
        : duration === 'now'
          ? t('codexResetCredit.nextExpiresNow')
          : t('codexResetCredit.nextExpiresDuration', { duration: duration })
  }
  return {
    availableCount: count,
    availabilityLabel:
      count === 1
        ? t('codexResetCredit.resetCountReset', { resetCount: count })
        : t('codexResetCredit.resetCountResets', { resetCount: count }),
    expiryLabel
  }
}

export function getCodexResetCreditOutcomeCopy(outcome: CodexResetCreditOutcome): {
  title: string
  message: string
} {
  switch (outcome) {
    case 'reset':
      return {
        title: t('codexResetCredit.rate'),
        message: t('codexResetCredit.codex')
      }
    case 'alreadyRedeemed':
      return {
        title: t('codexResetCredit.resetAlready'),
        message: t('codexResetCredit.codex')
      }
    case 'nothingToReset':
      return {
        title: t('codexResetCredit.nothing'),
        message: t('codexResetCredit.noEligible')
      }
    case 'noCredit':
      return {
        title: t('codexResetCredit.noReset'),
        message: t('codexResetCredit.account')
      }
  }
}

export function getActiveCodexAccountIdForRateLimitTarget(
  snapshot: AccountsSnapshot
): string | null {
  const target = snapshot.rateLimits.codexTarget
  const selection = snapshot.codex.activeAccountIdsByRuntime
  if (!selection) {
    return null
  }
  if (target.runtime === 'host') {
    return target.wslDistro === null ? selection.host : null
  }
  const distro = target.wslDistro?.trim()
  return distro ? (selection.wsl[distro] ?? null) : null
}

export function getCodexResetCreditScope(
  snapshot: AccountsSnapshot
): CodexResetCreditExpectedScope | null {
  const activeAccountId = getActiveCodexAccountIdForRateLimitTarget(snapshot)
  const account = activeAccountId
    ? (snapshot.codex.accounts.find((candidate) => candidate.id === activeAccountId) ?? null)
    : null
  const scope = buildCodexResetCreditExpectedScope({
    target: snapshot.rateLimits.codexTarget,
    account,
    limits: snapshot.rateLimits.codex
  })
  if (!scope) {
    return null
  }
  const parsed = CodexResetCreditExpectedScopeSchema.safeParse(scope)
  return parsed.success ? parsed.data : null
}

function scopesEqual(
  left: CodexResetCreditExpectedScope,
  right: CodexResetCreditExpectedScope
): boolean {
  return (
    left.target.runtime === right.target.runtime &&
    left.target.wslDistro === right.target.wslDistro &&
    left.accountId === right.accountId &&
    left.accountRevision === right.accountRevision &&
    left.offerRevision === right.offerRevision
  )
}

function decodeResetResult(
  value: unknown,
  expectedScope: CodexResetCreditExpectedScope
): CodexResetCreditRpcResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(t('codexResetCredit.invalid'))
  }
  const result = value as Record<string, unknown>
  const scope = CodexResetCreditExpectedScopeSchema.safeParse(result.scope)
  if (!scope.success || !scopesEqual(scope.data, expectedScope)) {
    throw new Error(t('codexResetCredit.invalid'))
  }
  const snapshot = decodeAccountsSnapshot(result.snapshot)
  if (result.status === 'rejectedBeforeProvider') {
    const reason = result.reason
    if (
      result.retryDisposition !== 'discardAttempt' ||
      result.outcome !== undefined ||
      (reason !== 'targetChanged' &&
        reason !== 'accountChanged' &&
        reason !== 'accountRevisionChanged' &&
        reason !== 'accountRuntimeChanged' &&
        reason !== 'offerUnavailable' &&
        reason !== 'offerChanged')
    ) {
      throw new Error(t('codexResetCredit.invalid'))
    }
    return {
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason,
      scope: scope.data,
      snapshot
    }
  }
  const outcome = result.outcome
  if (
    result.status !== undefined ||
    outcome === undefined ||
    (outcome !== 'reset' &&
      outcome !== 'nothingToReset' &&
      outcome !== 'noCredit' &&
      outcome !== 'alreadyRedeemed')
  ) {
    throw new Error(t('codexResetCredit.invalid'))
  }
  const snapshotAccount = snapshot.codex.accounts.find(
    (account) => account.id === scope.data.accountId
  )
  if (
    snapshot.rateLimits.codexTarget.runtime !== scope.data.target.runtime ||
    snapshot.rateLimits.codexTarget.wslDistro !== scope.data.target.wslDistro ||
    getActiveCodexAccountIdForRateLimitTarget(snapshot) !== scope.data.accountId ||
    snapshotAccount?.updatedAt !== scope.data.accountRevision
  ) {
    throw new Error(t('codexResetCredit.invalid'))
  }
  return {
    outcome,
    scope: scope.data,
    snapshot
  }
}

async function performCodexResetCreditRequest(
  client: Pick<RpcClient, 'sendRequest'>,
  options: {
    hostId: string
    expectedScope: CodexResetCreditExpectedScope
    createIdempotencyKey: () => string
  }
): Promise<CodexResetCreditRequestResult> {
  const attempt = await getOrCreateCodexResetAttempt(options)
  const response = await client.sendRequest(
    'accounts.consumeCodexResetCredit',
    {
      idempotencyKey: attempt.idempotencyKey,
      expectedScope: attempt.expectedScope
    },
    { timeoutMs: RESET_RPC_TIMEOUT_MS }
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result = decodeResetResult(response.result, attempt.expectedScope)
  let attemptJournalRetained = false
  try {
    await clearCodexResetAttemptAfterAuthoritativeResponse({
      hostId: options.hostId,
      expectedScope: attempt.expectedScope,
      idempotencyKey: attempt.idempotencyKey
    })
  } catch {
    attemptJournalRetained = true
  }
  return { ...result, attemptJournalRetained }
}

export async function requestCodexResetCredit(
  client: Pick<RpcClient, 'sendRequest'>,
  options: {
    hostId: string
    expectedScope: CodexResetCreditExpectedScope
    createIdempotencyKey: () => string
  }
): Promise<CodexResetCreditRequestResult> {
  const requestKey = getCodexResetAttemptIdentityKey(options)
  const existing = resetRequests.get(requestKey)
  if (existing) {
    return existing
  }
  // Why: two mounted views can confirm the same offer concurrently. Share the
  // whole attempt so one authoritative response cannot clear the other's retry key.
  const operation = performCodexResetCreditRequest(client, options)
  resetRequests.set(requestKey, operation)
  try {
    return await operation
  } finally {
    if (resetRequests.get(requestKey) === operation) {
      resetRequests.delete(requestKey)
    }
  }
}

/** Test-only: clear request singleflight state between cases. */
export function resetCodexResetCreditRequestsForTests(): void {
  resetRequests.clear()
}
