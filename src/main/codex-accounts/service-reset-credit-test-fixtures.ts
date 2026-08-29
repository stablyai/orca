import type { ProviderRateLimits, RateLimitState } from '../../shared/rate-limit-types'

export function createResetCreditLimits(updatedAt = 30): ProviderRateLimits {
  return {
    provider: 'codex',
    session: {
      usedPercent: 100,
      windowMinutes: 300,
      resetsAt: 1_000,
      resetDescription: 'soon'
    },
    weekly: null,
    rateLimitResetCredits: {
      availableCount: 1,
      totalEarnedCount: 1,
      nextExpiresAt: 2_000,
      credits: [{ status: 'available', expiresAt: 2_000, grantedAt: 500 }]
    },
    updatedAt,
    error: null,
    status: 'ok'
  }
}

export function createResetRateLimitState(
  codex: ProviderRateLimits,
  target: RateLimitState['codexTarget'] = { runtime: 'host', wslDistro: null }
): RateLimitState {
  return {
    claude: null,
    codex,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: target,
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}
