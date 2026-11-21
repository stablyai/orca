import { beforeEach, expect, it, vi } from 'vitest'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID } from '../../../shared/agent-accounts/claude/claude-system-default-usage'
import { RateLimitService } from './rate-limit-service'
import { okProvider } from './rate-limit-service-test-harness'

vi.mock('../providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: vi.fn()
}))
vi.mock('../../claude-accounts/profiles/routing/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({
    userConfigDir: () => '/home/me/.claude',
    // A legacy account without its own login reads System default's home.
    accountUsagePreparation: (accountId: string) =>
      accountId === 'own-login'
        ? {
            configDir: '/profiles/own-login',
            envPatch: { CLAUDE_CONFIG_DIR: '/profiles/own-login' },
            provenance: 'profile:own-login'
          }
        : SYSTEM_DEFAULT
  }),
  getClaudeWslProfileRouter: () => null
}))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: async () => false
}))
vi.mock('../../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: async () => false }))
vi.mock('../../zcode/zcode-plan-api-key-store', () => ({ hasZcodePlanApiKey: async () => false }))

const SYSTEM_DEFAULT = { configDir: '/home/me/.claude', envPatch: {}, provenance: 'system' }

beforeEach(() => {
  vi.mocked(fetchActiveClaudeRateLimits)
    .mockReset()
    .mockImplementation(async (options) =>
      okProvider('claude', options?.authPreparation?.configDir === '/profiles/own-login' ? 12 : 40)
    )
})

// #46002 follow-up: System default and legacy accounts sharing its login were each read again.
it('reads each Claude login once across the selected and unselected accounts', async () => {
  const service = new RateLimitService()
  // The selected legacy account runs on System default's login.
  service.setClaudeAuthPreparationResolver(async () => SYSTEM_DEFAULT)
  service.setInactiveClaudeAccountsResolver(() => [
    { id: 'legacy' },
    { id: 'own-login' },
    { id: CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID }
  ])

  await service.refreshClaudeForTarget()
  await service.fetchInactiveClaudeAccountsOnOpen()

  expect(fetchActiveClaudeRateLimits).toHaveBeenCalledTimes(2)
  const usedByAccount = Object.fromEntries(
    (await service.getState()).inactiveClaudeAccounts.map((entry) => [
      entry.accountId,
      entry.rateLimits?.session?.usedPercent
    ])
  )
  expect(usedByAccount).toEqual({
    legacy: 40,
    'own-login': 12,
    [CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID]: 40
  })
})
