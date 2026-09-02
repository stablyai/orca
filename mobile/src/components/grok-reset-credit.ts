import { formatResetCountdown } from '../../../src/shared/rate-limit-reset-format'
import type { RpcClient } from '../transport/rpc-client'
import {
  clearGrokResetAttemptAfterAuthoritativeResponse,
  getGrokResetAttemptIdentityKey,
  getOrCreateGrokResetAttempt
} from '../storage/grok-reset-attempt-journal'
import {
  decodeAccountsSnapshot,
  type AccountsSnapshot,
  type ProviderRateLimits
} from './accounts-snapshot'

export type GrokResetCreditOutcome =
  | 'reset'
  | 'nothingToReset'
  | 'noCredit'
  | 'alreadyRedeemed'
  | 'usageUnavailable'

export type GrokResetCreditRequestResult = {
  outcome: GrokResetCreditOutcome
  snapshot: AccountsSnapshot
  attemptJournalRetained: boolean
}

export type GrokResetCreditSummary = {
  availableCount: number
  availabilityLabel: string
  expiryLabel: string | null
}

const RESET_RPC_TIMEOUT_MS = 90_000
const resetRequests = new Map<string, Promise<GrokResetCreditRequestResult>>()

export function getGrokResetCreditSummary(
  limits: ProviderRateLimits | null,
  now: number
): GrokResetCreditSummary | null {
  const count = limits?.rateLimitResetCredits?.availableCount ?? 0
  if (!Number.isInteger(count) || count <= 0) {
    return null
  }
  const expiry = limits?.rateLimitResetCredits?.nextExpiresAt
  const expiryLabel =
    typeof expiry === 'number' && Number.isFinite(expiry)
      ? formatResetCountdown(expiry - now).replace(
          /^Resets/,
          count === 1 ? 'Expires' : 'Next expires'
        )
      : null
  return {
    availableCount: count,
    availabilityLabel: `${count} ${count === 1 ? 'reset' : 'resets'} available`,
    expiryLabel
  }
}

export function getGrokResetCreditOutcomeCopy(outcome: GrokResetCreditOutcome): {
  title: string
  message: string
} {
  switch (outcome) {
    case 'reset':
      return { title: 'Rate limits reset', message: 'Grok usage has been refreshed.' }
    case 'alreadyRedeemed':
      return { title: 'Reset already applied', message: 'Grok usage has been refreshed.' }
    case 'nothingToReset':
      return { title: 'Nothing to reset', message: 'No eligible Grok usage window is exhausted.' }
    case 'noCredit':
      return {
        title: 'No reset available',
        message: 'This account has no SuperGrok usage-limit reset tokens available.'
      }
    case 'usageUnavailable':
      return { title: 'Could not verify Grok usage', message: 'Try again.' }
  }
}

function decodeGrokResetResult(
  value: unknown
): Omit<GrokResetCreditRequestResult, 'attemptJournalRetained'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid reset response from host')
  }
  const result = value as Record<string, unknown>
  const outcome = result.outcome
  if (
    outcome !== 'reset' &&
    outcome !== 'nothingToReset' &&
    outcome !== 'noCredit' &&
    outcome !== 'alreadyRedeemed' &&
    outcome !== 'usageUnavailable'
  ) {
    throw new Error('Invalid reset response from host')
  }
  return { outcome, snapshot: decodeAccountsSnapshot(result.snapshot) }
}

async function performGrokResetCreditRequest(
  client: Pick<RpcClient, 'sendRequest'>,
  options: { hostId: string; createIdempotencyKey: () => string }
): Promise<GrokResetCreditRequestResult> {
  const attempt = await getOrCreateGrokResetAttempt(options.hostId, options.createIdempotencyKey)
  const response = await client.sendRequest(
    'accounts.consumeGrokResetCredit',
    { idempotencyKey: attempt.idempotencyKey },
    { timeoutMs: RESET_RPC_TIMEOUT_MS }
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result = decodeGrokResetResult(response.result)
  let attemptJournalRetained = result.outcome === 'usageUnavailable'
  if (!attemptJournalRetained) {
    try {
      await clearGrokResetAttemptAfterAuthoritativeResponse(attempt)
    } catch {
      attemptJournalRetained = true
    }
  }
  return { ...result, attemptJournalRetained }
}

export async function requestGrokResetCredit(
  client: Pick<RpcClient, 'sendRequest'>,
  options: { hostId: string; createIdempotencyKey: () => string }
): Promise<GrokResetCreditRequestResult> {
  const requestKey = getGrokResetAttemptIdentityKey(options.hostId)
  const existing = resetRequests.get(requestKey)
  if (existing) {
    return existing
  }
  const operation = performGrokResetCreditRequest(client, options)
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
export function resetGrokResetCreditRequestsForTests(): void {
  resetRequests.clear()
}
