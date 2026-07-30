import {
  buildCodexResetCreditExpectedScope,
  type CodexResetCreditExpectedScope
} from '../../src/shared/codex-reset-credit-scope'

type MockCodexUsage = {
  availableResetCredits: number
  sessionUsedPercent: number
  updatedAt: number
  nextExpiresAt: number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CODEX_ACCOUNTS = [
  {
    id: 'codex-personal',
    email: 'dev@example.com',
    workspaceLabel: 'Personal',
    managedHomeRuntime: 'host' as const,
    wslDistro: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  },
  {
    id: 'codex-team',
    email: 'dev@example.com',
    workspaceLabel: 'Example Team',
    managedHomeRuntime: 'host' as const,
    wslDistro: null,
    createdAt: 2,
    updatedAt: 2,
    lastAuthenticatedAt: 2
  }
] as const

let fixtureStartedAt = Date.now()
let activeClaudeAccountId: string | null = 'claude-team'
let activeCodexAccountId: string | null = 'codex-personal'
let codexUsageByAccount = new Map<string, MockCodexUsage>()
let resetOperations = new Map<string, { scopeKey: string; outcome: 'reset' | 'noCredit' }>()
let resetOfferOwners = new Map<string, string>()

function createInitialCodexUsage(accountOffset: number): MockCodexUsage {
  return {
    availableResetCredits: 1,
    sessionUsedPercent: 100,
    updatedAt: fixtureStartedAt + accountOffset,
    nextExpiresAt: fixtureStartedAt + (5 + accountOffset) * 24 * 60 * 60 * 1000
  }
}

export function resetMockAccountState(now = Date.now()): void {
  fixtureStartedAt = now
  activeClaudeAccountId = 'claude-team'
  activeCodexAccountId = 'codex-personal'
  codexUsageByAccount = new Map([
    ['codex-personal', createInitialCodexUsage(0)],
    ['codex-team', createInitialCodexUsage(1)]
  ])
  resetOperations = new Map()
  resetOfferOwners = new Map()
}

resetMockAccountState(fixtureStartedAt)

export function selectMockClaudeAccount(accountId: unknown): void {
  if (accountId === null) {
    activeClaudeAccountId = null
    return
  }
  if (accountId !== 'claude-team' && accountId !== 'claude-personal') {
    throw new Error('Unknown Claude account')
  }
  activeClaudeAccountId = accountId
}

export function selectMockCodexAccount(accountId: unknown): void {
  if (accountId === null) {
    activeCodexAccountId = null
    return
  }
  if (
    typeof accountId !== 'string' ||
    !CODEX_ACCOUNTS.some((account) => account.id === accountId)
  ) {
    throw new Error('Unknown Codex account')
  }
  activeCodexAccountId = accountId
}

function codexLimitsFor(accountId: string | null) {
  const usage = accountId ? codexUsageByAccount.get(accountId) : null
  if (!usage) {
    return {
      provider: 'codex' as const,
      session: null,
      weekly: null,
      rateLimitResetCredits: { availableCount: 0, totalEarnedCount: 0, nextExpiresAt: null },
      updatedAt: fixtureStartedAt,
      error: 'No managed Codex account selected',
      status: 'unavailable' as const
    }
  }
  return {
    provider: 'codex' as const,
    session: {
      usedPercent: usage.sessionUsedPercent,
      windowMinutes: 300,
      resetsAt: fixtureStartedAt + 90 * 60 * 1000,
      resetDescription: null
    },
    weekly: {
      usedPercent: 77,
      windowMinutes: 10_080,
      resetsAt: fixtureStartedAt + 3 * 24 * 60 * 60 * 1000,
      resetDescription: null
    },
    rateLimitResetCredits: {
      availableCount: usage.availableResetCredits,
      totalEarnedCount: 2,
      nextExpiresAt: usage.availableResetCredits > 0 ? usage.nextExpiresAt : null
    },
    updatedAt: usage.updatedAt,
    error: null,
    status: 'ok' as const
  }
}

export function getMockCodexResetScope(): CodexResetCreditExpectedScope | null {
  const account = CODEX_ACCOUNTS.find((candidate) => candidate.id === activeCodexAccountId) ?? null
  return buildCodexResetCreditExpectedScope({
    target: { runtime: 'host', wslDistro: null },
    account,
    limits: codexLimitsFor(activeCodexAccountId)
  })
}

export function consumeMockCodexResetCredit(
  idempotencyKey: unknown,
  expectedScope: unknown
):
  | { outcome: 'reset' | 'noCredit'; scope: CodexResetCreditExpectedScope }
  | {
      status: 'rejectedBeforeProvider'
      retryDisposition: 'discardAttempt'
      reason: 'offerChanged'
      scope: CodexResetCreditExpectedScope
    } {
  if (typeof idempotencyKey !== 'string' || !UUID_PATTERN.test(idempotencyKey)) {
    throw new Error('Invalid idempotencyKey')
  }
  if (!expectedScope || typeof expectedScope !== 'object') {
    throw new Error('Missing expectedScope')
  }
  const suppliedScopeKey = JSON.stringify(expectedScope)
  const previous = resetOperations.get(idempotencyKey)
  if (previous) {
    if (previous.scopeKey !== suppliedScopeKey) {
      throw new Error('The reset operation belongs to a different account scope')
    }
    return {
      outcome: previous.outcome,
      scope: expectedScope as CodexResetCreditExpectedScope
    }
  }

  const currentScope = getMockCodexResetScope()
  if (!currentScope || JSON.stringify(currentScope) !== suppliedScopeKey) {
    return {
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope: expectedScope as CodexResetCreditExpectedScope
    }
  }
  const offerKey = suppliedScopeKey
  const owner = resetOfferOwners.get(offerKey)
  if (owner && owner !== idempotencyKey) {
    throw new Error('That reset offer is already being redeemed')
  }
  resetOfferOwners.set(offerKey, idempotencyKey)

  const usage = codexUsageByAccount.get(currentScope.accountId)
  const outcome = usage && usage.availableResetCredits > 0 ? 'reset' : 'noCredit'
  resetOperations.set(idempotencyKey, { scopeKey: suppliedScopeKey, outcome })
  if (usage && outcome === 'reset') {
    usage.availableResetCredits = 0
    usage.sessionUsedPercent = 0
    usage.updatedAt += 1
  }
  return { outcome, scope: currentScope }
}

export function createMockAccountsSnapshot() {
  const codexLimits = codexLimitsFor(activeCodexAccountId)
  return {
    claude: {
      accounts: [
        { id: 'claude-team', email: 'dev@example.com', organizationName: 'Example Team' },
        { id: 'claude-personal', email: 'personal@example.com', organizationName: null }
      ],
      activeAccountId: activeClaudeAccountId
    },
    codex: {
      accounts: CODEX_ACCOUNTS.map((account) => ({ ...account })),
      activeAccountId: activeCodexAccountId,
      activeAccountIdsByRuntime: { host: activeCodexAccountId, wsl: {} }
    },
    rateLimits: {
      claude: {
        provider: 'claude' as const,
        session: {
          usedPercent: 38,
          windowMinutes: 300,
          resetsAt: fixtureStartedAt + 2 * 60 * 60 * 1000,
          resetDescription: null
        },
        weekly: {
          usedPercent: 61,
          windowMinutes: 10_080,
          resetsAt: fixtureStartedAt + 4 * 24 * 60 * 60 * 1000,
          resetDescription: null
        },
        updatedAt: fixtureStartedAt,
        error: null,
        status: 'ok' as const
      },
      codex: codexLimits,
      claudeTarget: { runtime: 'host' as const, wslDistro: null },
      codexTarget: { runtime: 'host' as const, wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: CODEX_ACCOUNTS.filter(
        (account) => account.id !== activeCodexAccountId
      ).map((account) => ({
        accountId: account.id,
        rateLimits: codexLimitsFor(account.id),
        updatedAt: codexUsageByAccount.get(account.id)?.updatedAt ?? fixtureStartedAt,
        isFetching: false
      }))
    }
  }
}
