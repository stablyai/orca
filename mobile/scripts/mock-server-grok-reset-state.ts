const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let fixtureStartedAt = Date.now()
let weeklyUsedPercent = 40
let resetCredits = 1
let resetOperations = new Map<string, 'reset' | 'noCredit' | 'nothingToReset'>()

export function resetMockGrokState(now: number): void {
  fixtureStartedAt = now
  weeklyUsedPercent = 40
  resetCredits = 1
  resetOperations = new Map()
}

export function consumeMockGrokResetCredit(idempotencyKey: unknown): {
  outcome: 'reset' | 'noCredit' | 'nothingToReset'
} {
  if (typeof idempotencyKey !== 'string' || !UUID_PATTERN.test(idempotencyKey)) {
    throw new Error('Invalid idempotencyKey')
  }
  const previous = resetOperations.get(idempotencyKey)
  if (previous) {
    return { outcome: previous }
  }
  const outcome =
    weeklyUsedPercent <= 0 ? 'nothingToReset' : resetCredits <= 0 ? 'noCredit' : 'reset'
  resetOperations.set(idempotencyKey, outcome)
  if (outcome === 'reset') {
    resetCredits = 0
    weeklyUsedPercent = 0
  }
  return { outcome }
}

export function createMockGrokRateLimits() {
  return {
    provider: 'grok' as const,
    session: null,
    weekly: {
      usedPercent: weeklyUsedPercent,
      windowMinutes: 10_080,
      resetsAt: fixtureStartedAt + 6 * 24 * 60 * 60 * 1000,
      resetDescription: null
    },
    rateLimitResetCredits: {
      availableCount: resetCredits,
      nextExpiresAt: resetCredits > 0 ? fixtureStartedAt + 16 * 24 * 60 * 60 * 1000 : null
    },
    usageMetadata: { authProvenance: 'dev@example.com (SuperGrok Heavy)' },
    updatedAt: fixtureStartedAt,
    error: null,
    status: 'ok' as const
  }
}
