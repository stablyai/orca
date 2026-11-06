import { textGenerationFailure } from '../../shared/text-generation-failure-copy'
import { localGenerationCanceledResult } from './source-control-generation-lanes'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import type {
  InternalTextGenerationResult,
  LocalGenerationTarget
} from './source-control-text-generation-types'
import type { TextSubscriptionAttempt } from './text-subscription-failover'

const PROVIDER_FAILURE_MESSAGE_LIMIT = 1000

// Only provider-authored prose reaches failure detail; the shared sanitizer later redacts paths.
export function providerFailureMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const message = value.trim().slice(0, PROVIDER_FAILURE_MESSAGE_LIMIT)
  return message && !/^[[{]/.test(message) ? message : undefined
}

type FailedResult = Extract<InternalTextGenerationResult, { success: false }>
type RecoveryReason = NonNullable<FailedResult['subscriptionRecovery']>['reason']
// A non-quota failure keeps the alternate's own error copy, so only these replace it.
type ExhaustionReason = Exclude<RecoveryReason, 'non-quota-failure'>

// Keeps the first refusal's sanitized errorDetail as the diagnostic.
function withoutFailureCopy(value: FailedResult): FailedResult {
  const copy = { ...value }
  delete copy.errorCode
  delete copy.errorParams
  return copy
}

function exhaustionCopy(reason: ExhaustionReason, attempted: number) {
  switch (reason) {
    case 'exhausted':
      return textGenerationFailure('subscriptionAccountsExhausted', { attempted })
    case 'attempt-limit':
      return textGenerationFailure('subscriptionAttemptLimit', { attempted })
    case 'budget-ended':
      return textGenerationFailure('subscriptionBudgetEnded')
    case 'no-eligible-alternate':
      return textGenerationFailure('subscriptionNoEligibleAlternate')
  }
}

export async function runTextSubscriptionRequest(input: {
  target: LocalGenerationTarget
  execute: (target: LocalGenerationTarget, model?: string) => Promise<InternalTextGenerationResult>
}): Promise<InternalTextGenerationResult> {
  const { target } = input
  const { subscription, request } = target
  if (!subscription || !request) {
    return input.execute(target)
  }
  let firstRefusal: FailedResult | undefined
  let attemptedCount = 1
  const recovery = (value: FailedResult, reason: RecoveryReason): FailedResult => {
    const firstErrorCode = firstRefusal?.errorCode
    console.warn('[text-generation] subscription failover ended', {
      reason,
      attemptedCount,
      firstErrorCode
    })
    return {
      ...value,
      subscriptionRecovery: {
        attemptedCount,
        reason,
        firstError: firstRefusal?.error ?? value.error,
        ...(firstErrorCode ? { firstErrorCode } : {})
      }
    }
  }
  const exhausted = (refusal: FailedResult, reason: ExhaustionReason): FailedResult =>
    recovery({ ...withoutFailureCopy(refusal), ...exhaustionCopy(reason, attemptedCount) }, reason)
  // Full validation re-resolves the target; it runs only after external work, not back-to-back.
  const validRequest = async () => {
    try {
      return (await request.validate()) && subscription.current()
    } catch {
      return false
    }
  }
  const liveRequest = () => {
    try {
      return request.current() && subscription.current()
    } catch {
      return false
    }
  }
  const canceled = (): InternalTextGenerationResult => {
    const deadline =
      request.signal.reason === 'deadline' ||
      (!request.signal.aborted && Date.now() >= request.deadline)
    if (!deadline) {
      return localGenerationCanceledResult()
    }
    return firstRefusal
      ? exhausted(firstRefusal, 'budget-ended')
      : {
          success: false,
          ...textGenerationFailure('timedOut', {
            seconds: SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000
          })
        }
  }
  const untilStopped = <T>(pending: () => T | Promise<T>, fallback: T): Promise<T> => {
    if (request.signal.aborted) {
      return Promise.resolve(fallback)
    }
    // A throwing or rejecting provider hook counts as an unusable account, never a request failure.
    const settled = Promise.resolve()
      .then(pending)
      .catch(() => fallback)
    let detach = () => {}
    return new Promise<T>((resolve) => {
      const stop = () => resolve(fallback)
      request.signal.addEventListener('abort', stop, { once: true })
      detach = () => request.signal.removeEventListener('abort', stop)
      void settled.then(resolve)
    }).finally(() => detach())
  }
  const prepare = (id: string) => untilStopped(() => subscription.prepare(id), null)
  const execute = async (
    attempt: TextSubscriptionAttempt
  ): Promise<InternalTextGenerationResult> => {
    const result = await input.execute(
      { ...target, subscription: undefined, accountAttempt: attempt, env: attempt.env },
      attempt.model
    )
    const confirmQuota = subscription.confirmQuota
    if (
      !result.success &&
      !result.subscriptionQuotaRefused &&
      result.subscriptionQuotaDiagnostic &&
      confirmQuota &&
      (await untilStopped(() => confirmQuota(attempt), false))
    ) {
      return (await validRequest()) ? { ...result, subscriptionQuotaRefused: true } : canceled()
    }
    return result
  }
  // execute already revalidated; only sync request state can change after it returns.
  const settledAfterRun = (result: InternalTextGenerationResult) =>
    liveRequest() && !(!result.success && result.canceled)
  // Failover off would have run the ordinary command; an unusable initial account must not do worse.
  const ordinary = async (): Promise<InternalTextGenerationResult> => {
    let env: NodeJS.ProcessEnv | undefined
    try {
      env = (await subscription.fallbackEnvironment?.()) ?? target.env
    } catch {
      return { success: false, error: 'Could not prepare the generation environment.' }
    }
    return await input.execute({ ...target, subscription: undefined, env })
  }
  if (!(await validRequest())) {
    return canceled()
  }
  const initial = await prepare(subscription.initialAccountId)
  const initialValid = initial ? await untilStopped(() => initial.valid(), false) : false
  if (!(await validRequest())) {
    return canceled()
  }
  if (!initial || !initialValid) {
    return ordinary()
  }
  const first = await execute(initial)
  if (!settledAfterRun(first)) {
    return canceled()
  }
  if (!first.success && first.subscriptionAccountChanged) {
    return ordinary()
  }
  if (first.success || !first.subscriptionQuotaRefused) {
    return first
  }
  const refusal = first
  firstRefusal = refusal
  const ranked = await untilStopped<string[]>(() => subscription.candidates(), [])
  if (!(await validRequest())) {
    return canceled()
  }
  // Slots go to distinct managed IDs; a prepared alias of a used identity still spends its slot.
  const alternates = [...new Set(ranked)].filter((id) => id !== initial.accountId)
  const seen = new Set([initial.identity])
  for (const id of alternates.slice(0, 2)) {
    if (!liveRequest()) {
      return canceled()
    }
    if (request.remainingSpawns() < 1) {
      return exhausted(refusal, 'budget-ended')
    }
    const attempt = await prepare(id)
    if (!(await validRequest())) {
      return canceled()
    }
    if (!attempt || seen.has(attempt.identity)) {
      continue
    }
    seen.add(attempt.identity)
    if (attempt.model !== initial.model || !(await untilStopped(() => attempt.valid(), false))) {
      continue
    }
    if (request.remainingSpawns() < 1) {
      return exhausted(refusal, 'budget-ended')
    }
    attemptedCount += 1
    const result = await execute(attempt)
    if (!settledAfterRun(result)) {
      return canceled()
    }
    if (result.success) {
      return result
    }
    if (result.errorCode === 'generationAttemptBudgetEnded') {
      return exhausted(refusal, 'budget-ended')
    }
    if (result.subscriptionAccountChanged) {
      attemptedCount -= 1
      continue
    }
    if (!result.subscriptionQuotaRefused) {
      return recovery(result, 'non-quota-failure')
    }
  }
  // Every executed alternate refused on quota; skipped ones matter only when none ran.
  return exhausted(
    refusal,
    attemptedCount === 1
      ? 'no-eligible-alternate'
      : alternates.length > 2
        ? 'attempt-limit'
        : 'exhausted'
  )
}
