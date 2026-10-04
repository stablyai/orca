export const MOBILE_DEEPSEEK_BALANCE = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '9007199254740993.00100',
      granted_balance: '0.00100',
      topped_up_balance: '9007199254740993.00000'
    },
    {
      currency: 'USD',
      total_balance: '12.3400',
      granted_balance: '2.3400',
      topped_up_balance: '10.0000'
    }
  ]
}

export const MOBILE_DEEPSEEK_LIMITS = {
  provider: 'deepseek',
  session: null,
  weekly: null,
  updatedAt: 100,
  error: null,
  status: 'ok',
  balance: MOBILE_DEEPSEEK_BALANCE
}

export const MOBILE_DEEPSEEK_ACCOUNT = {
  supported: true,
  configured: true,
  ownerId: 'fixture-owner',
  protection: 'sealed'
}

export function deepSeekMobileSnapshot(overrides: Record<string, unknown> = {}): unknown {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: {
        provider: 'claude',
        session: { usedPercent: 25, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: null,
        status: 'ok',
        updatedAt: 100,
        error: null
      },
      codex: null,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      deepseek: MOBILE_DEEPSEEK_LIMITS,
      deepseekAccount: MOBILE_DEEPSEEK_ACCOUNT,
      ...overrides
    }
  }
}
