import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import { getClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import {
  CLAUDE_SYSTEM_DEFAULT_INACTIVE_ACCOUNT_ID,
  claudeInactiveUsageAccountId,
  claudeRowCanShowNotChecked,
  inactiveClaudeMenuAccounts
} from '../../../../shared/agent-accounts/claude/claude-system-default-inactive'
import { fetchInactiveClaudeMenuUsage } from './claude-system-default-inactive-usage'

vi.mock('./claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: vi.fn()
}))

vi.mock('../../../claude-accounts/profiles/routing/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: vi.fn(),
  getClaudeWslProfileRouter: vi.fn()
}))

const savedPreparation = {
  configDir: '/profiles/saved-a',
  envPatch: { CLAUDE_CONFIG_DIR: '/profiles/saved-a' },
  provenance: 'profile:saved-a',
  readingAccount: { accountId: 'saved-a', runtime: 'host' as const, wslDistro: null }
}

describe('inactive Claude System default usage', () => {
  const accountUsagePreparation = vi.fn(() => savedPreparation)
  const systemDefaultHome = vi.fn(() => '/home/user/.claude')

  beforeEach(() => {
    accountUsagePreparation.mockClear()
    systemDefaultHome.mockClear()
    vi.mocked(fetchActiveClaudeRateLimits).mockReset()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue({ status: 'ok' } as never)
    vi.mocked(getClaudeProfileRouter).mockReturnValue({
      accountUsagePreparation,
      systemDefaultHome
    } as never)
  })

  it('adds the host System default sentinel while a saved account is selected', () => {
    const inactiveSaved = [
      {
        id: 'saved-b',
        managedAuthRuntime: 'wsl' as const,
        wslDistro: 'Ubuntu',
        wslLinuxAuthPath: '/home/wsl/.claude'
      }
    ]
    expect(inactiveClaudeMenuAccounts(inactiveSaved, 'saved-a')).toEqual([
      ...inactiveSaved,
      { id: CLAUDE_SYSTEM_DEFAULT_INACTIVE_ACCOUNT_ID }
    ])
    expect(inactiveClaudeMenuAccounts(inactiveSaved, null)).toEqual(inactiveSaved)
  })

  it('reads the sentinel only for an inactive host System default row', () => {
    expect(claudeInactiveUsageAccountId({ id: null, active: false, runtime: 'host' })).toBe(
      CLAUDE_SYSTEM_DEFAULT_INACTIVE_ACCOUNT_ID
    )
    expect(claudeInactiveUsageAccountId({ id: null, active: false, runtime: 'wsl' })).toBeNull()
    expect(claudeInactiveUsageAccountId({ id: 'saved-a', active: false, runtime: 'host' })).toBe(
      'saved-a'
    )
    expect(claudeInactiveUsageAccountId({ id: null, active: true, runtime: 'host' })).toBeNull()
  })

  it('offers Not checked for the inactive host System default row on this device', () => {
    expect(claudeRowCanShowNotChecked({ id: null, active: false, runtime: 'host' }, false)).toBe(
      true
    )
    expect(claudeRowCanShowNotChecked({ id: null, active: false, runtime: 'wsl' }, false)).toBe(
      false
    )
    expect(
      claudeRowCanShowNotChecked({ id: 'saved-a', active: false, runtime: 'host' }, false)
    ).toBe(true)
    expect(claudeRowCanShowNotChecked({ id: null, active: false, runtime: 'host' }, true)).toBe(
      false
    )
    expect(claudeRowCanShowNotChecked({ id: null, active: true, runtime: 'host' }, false)).toBe(
      false
    )
  })

  it('reads System default home for the sentinel instead of a saved profile', async () => {
    await fetchInactiveClaudeMenuUsage({ id: CLAUDE_SYSTEM_DEFAULT_INACTIVE_ACCOUNT_ID })
    expect(accountUsagePreparation).not.toHaveBeenCalled()
    expect(fetchActiveClaudeRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        authPreparation: {
          configDir: '/home/user/.claude',
          envPatch: {},
          provenance: 'system'
        }
      })
    )
  })

  it('still prepares a saved inactive account from its own profile', async () => {
    await fetchInactiveClaudeMenuUsage({ id: 'saved-a', managedAuthRuntime: 'host' })
    expect(accountUsagePreparation).toHaveBeenCalledWith('saved-a')
    expect(systemDefaultHome).not.toHaveBeenCalled()
    expect(fetchActiveClaudeRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({ authPreparation: savedPreparation })
    )
  })
})
