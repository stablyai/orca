export function createMockCursorRateLimits(fixtureStartedAt: number) {
  return {
    provider: 'cursor' as const,
    session: null,
    weekly: null,
    buckets: [
      {
        name: 'Cursor Models',
        usedPercent: 100,
        windowMinutes: 43_200,
        resetsAt: fixtureStartedAt + 4 * 60 * 60 * 1000,
        resetDescription: 'Aug 27'
      },
      {
        name: 'Other Models',
        usedPercent: 100,
        windowMinutes: 43_200,
        resetsAt: fixtureStartedAt + 4 * 60 * 60 * 1000,
        resetDescription: 'Aug 27'
      },
      {
        name: 'Grok Bot',
        usedPercent: 0,
        windowMinutes: 10_080,
        resetsAt: fixtureStartedAt + 4 * 24 * 60 * 60 * 1000,
        resetDescription: 'Aug 31'
      }
    ],
    planType: 'ultra',
    usageMetadata: {
      accountEmail: 'dev@example.com',
      subscriptionStatus: 'active'
    },
    updatedAt: fixtureStartedAt,
    error: null,
    status: 'ok' as const
  }
}
