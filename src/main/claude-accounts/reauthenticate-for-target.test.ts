import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'

const CLAUDE_SERVICE_TEST_ROOT = '/tmp/orca-claude-reauth-for-target-test'

vi.mock('electron', () => ({
  app: { getPath: () => CLAUDE_SERVICE_TEST_ROOT }
}))
vi.mock('../codex-cli/command', () => ({ resolveClaudeCommand: vi.fn(() => 'claude') }))
vi.mock('./keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async () => {}),
  deleteManagedClaudeKeychainCredentials: vi.fn(async () => {}),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  writeManagedClaudeKeychainCredentials: vi.fn(async () => {})
}))

function settingsWith(
  overrides: Partial<
    Pick<GlobalSettings, 'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'>
  >
): Pick<GlobalSettings, 'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'> {
  return {
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: undefined,
    ...overrides
  }
}

describe('ClaudeAccountService.reauthenticateAccountForTarget', () => {
  it('resolves the selected account for the target and delegates to reauthenticateAccount', async () => {
    const { ClaudeAccountService } = await import('./service')
    const settings = settingsWith({ activeClaudeManagedAccountId: 'account-host' })
    const store = { getSettings: () => settings }
    const service = new ClaudeAccountService(store as never, {} as never, {} as never)
    const reauthenticateAccount = vi
      .spyOn(service, 'reauthenticateAccount')
      .mockResolvedValue({ accounts: [], activeAccountId: null } as never)

    await service.reauthenticateAccountForTarget({ runtime: 'host' })

    expect(reauthenticateAccount).toHaveBeenCalledWith('account-host')
  })

  it('resolves the selected account for a WSL distro target', async () => {
    const { ClaudeAccountService } = await import('./service')
    const settings = settingsWith({
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-wsl' } }
    })
    const store = { getSettings: () => settings }
    const service = new ClaudeAccountService(store as never, {} as never, {} as never)
    const reauthenticateAccount = vi
      .spyOn(service, 'reauthenticateAccount')
      .mockResolvedValue({ accounts: [], activeAccountId: null } as never)

    await service.reauthenticateAccountForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(reauthenticateAccount).toHaveBeenCalledWith('account-wsl')
  })

  it('rejects without calling reauthenticateAccount when no account is selected for the target', async () => {
    const { ClaudeAccountService } = await import('./service')
    const settings = settingsWith({})
    const store = { getSettings: () => settings }
    const service = new ClaudeAccountService(store as never, {} as never, {} as never)
    const reauthenticateAccount = vi.spyOn(service, 'reauthenticateAccount')

    await expect(service.reauthenticateAccountForTarget({ runtime: 'host' })).rejects.toThrow(
      /no claude account is configured/i
    )
    expect(reauthenticateAccount).not.toHaveBeenCalled()
  })
})
