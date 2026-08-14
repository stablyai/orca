import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'

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

type ClaudeAccountServiceInternals = {
  doReauthenticateAccount: (accountId: string) => Promise<unknown>
  serializeMutation: <T>(fn: () => Promise<T>) => Promise<T>
}

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

function mockDoReauthenticateAccount(service: object) {
  const internals = service as unknown as ClaudeAccountServiceInternals
  return vi
    .spyOn(internals, 'doReauthenticateAccount')
    .mockResolvedValue({ accounts: [], activeAccountId: null })
}

describe('ClaudeAccountService.reauthenticateAccountForTarget', () => {
  it('resolves the selected account for the target and delegates to doReauthenticateAccount', async () => {
    const { ClaudeAccountService } = await import('./service')
    const settings = settingsWith({ activeClaudeManagedAccountId: 'account-host' })
    const store = { getSettings: () => settings }
    const service = new ClaudeAccountService(store as never, {} as never, {} as never)
    const doReauthenticateAccount = mockDoReauthenticateAccount(service)

    await service.reauthenticateAccountForTarget({ runtime: 'host' })

    expect(doReauthenticateAccount).toHaveBeenCalledWith('account-host')
  })

  it('resolves the selected account for a WSL distro target', async () => {
    const { ClaudeAccountService } = await import('./service')
    const settings = settingsWith({
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-wsl' } }
    })
    const store = { getSettings: () => settings }
    const service = new ClaudeAccountService(store as never, {} as never, {} as never)
    const doReauthenticateAccount = mockDoReauthenticateAccount(service)

    await service.reauthenticateAccountForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(doReauthenticateAccount).toHaveBeenCalledWith('account-wsl')
  })

  it('rejects without calling doReauthenticateAccount when no account is selected for the target', async () => {
    const { ClaudeAccountService } = await import('./service')
    const settings = settingsWith({})
    const store = { getSettings: () => settings }
    const service = new ClaudeAccountService(store as never, {} as never, {} as never)
    const doReauthenticateAccount = mockDoReauthenticateAccount(service)

    await expect(service.reauthenticateAccountForTarget({ runtime: 'host' })).rejects.toThrow(
      /no claude account is configured/i
    )
    expect(doReauthenticateAccount).not.toHaveBeenCalled()
  })

  it('regression: resolves the account selection at execution time, not at call time', async () => {
    // A queued mutation (e.g. a concurrent selectAccountForTarget) can change
    // which account is active between when reauthenticateAccountForTarget is
    // called and when its turn in the serialized queue actually runs. The
    // account read must reflect settings as of execution, never a snapshot
    // taken before this call even entered the queue.
    const { ClaudeAccountService } = await import('./service')
    let activeAccountId = 'account-old'
    const store = {
      getSettings: () => settingsWith({ activeClaudeManagedAccountId: activeAccountId })
    }
    const service = new ClaudeAccountService(store as never, {} as never, {} as never)
    const doReauthenticateAccount = mockDoReauthenticateAccount(service)

    let releaseBlocker: (() => void) | undefined
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })
    // Occupy the mutation queue before reauthenticateAccountForTarget is even called.
    const blockingMutation = (
      service as unknown as ClaudeAccountServiceInternals
    ).serializeMutation(() => blocker)

    const reauthPromise = service.reauthenticateAccountForTarget({ runtime: 'host' })

    // The active account changes while reauthenticateAccountForTarget is
    // still queued behind the blocker.
    activeAccountId = 'account-new'
    releaseBlocker?.()
    await blockingMutation
    await reauthPromise

    expect(doReauthenticateAccount).toHaveBeenCalledWith('account-new')
    expect(doReauthenticateAccount).not.toHaveBeenCalledWith('account-old')
  })
})
