export type QuotaFallbackRoute = 'antigravity-opus' | 'claude-api' | 'openai-api'

export type QuotaFallbackCandidate = {
  route: QuotaFallbackRoute
  observedAt: number
  available: boolean
  modelCompatible: boolean
  fiveHourRemaining?: number
  weeklyRemaining?: number
  credit?: {
    remainingUsd: number
    maxDebitUsd: number
    expiresAt: number
    paidOverflowBlocked: boolean
  }
}

export type QuotaFallbackInput = {
  enabled: boolean
  provider: 'claude' | 'codex'
  billing: 'subscription' | 'api'
  errorCode: string
  turnId: string
  currentTurnId: string
  settled: boolean
  pending: boolean
  candidates: readonly QuotaFallbackCandidate[]
  now: number
}

export type QuotaFallbackDecision =
  | { kind: 'switch'; route: QuotaFallbackRoute }
  | { kind: 'hold'; reason: string }

const ROUTES: Record<QuotaFallbackInput['provider'], readonly QuotaFallbackRoute[]> = {
  claude: ['antigravity-opus', 'claude-api'],
  codex: ['openai-api']
}

function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function usable(candidate: QuotaFallbackCandidate, now: number): boolean {
  if (
    !candidate.available ||
    !candidate.modelCompatible ||
    !Number.isFinite(candidate.observedAt) ||
    candidate.observedAt > now ||
    now - candidate.observedAt > 60_000
  ) {
    return false
  }
  if (candidate.route === 'antigravity-opus') {
    return positive(candidate.fiveHourRemaining) && positive(candidate.weeklyRemaining)
  }
  const credit = candidate.credit
  return Boolean(
    credit &&
    credit.paidOverflowBlocked &&
    positive(credit.remainingUsd) &&
    positive(credit.maxDebitUsd) &&
    credit.maxDebitUsd <= credit.remainingUsd &&
    Number.isFinite(credit.expiresAt) &&
    credit.expiresAt > now
  )
}

export function decideQuotaFallback(input: QuotaFallbackInput): QuotaFallbackDecision {
  if (!input.enabled) {
    return { kind: 'hold', reason: 'disabled' }
  }
  if (!Number.isFinite(input.now)) {
    return { kind: 'hold', reason: 'invalidClock' }
  }
  if (input.billing !== 'subscription') {
    return { kind: 'hold', reason: 'notSubscription' }
  }
  const expectedCode = input.provider === 'claude' ? 'usage_limit_reached' : 'usageLimitExceeded'
  if (input.errorCode !== expectedCode) {
    return { kind: 'hold', reason: 'quotaUnconfirmed' }
  }
  if (!input.turnId || input.turnId !== input.currentTurnId) {
    return { kind: 'hold', reason: 'turnSuperseded' }
  }
  if (!input.settled || input.pending) {
    return { kind: 'hold', reason: 'workUnsettled' }
  }
  for (const route of ROUTES[input.provider]) {
    const matches = input.candidates.filter((candidate) => candidate.route === route)
    if (matches.length === 1 && usable(matches[0], input.now)) {
      return { kind: 'switch', route }
    }
  }
  return { kind: 'hold', reason: 'noVerifiedRoute' }
}
