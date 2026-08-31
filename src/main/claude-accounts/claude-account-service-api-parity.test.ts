import { describe, expect, it, vi } from 'vitest'
import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import { ClaudeAccountService } from './service'
import type { ClaudeAccountAddTarget, ClaudeAccountImportOptions } from './service'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-claude-api-parity' } }))

type PublicClaudeAccountService = {
  listAccounts(): ClaudeRateLimitAccountsState
  addAccount(target?: ClaudeAccountAddTarget): Promise<ClaudeRateLimitAccountsState>
  addAccountFromConfigDir(
    configDir: string,
    options?: ClaudeAccountImportOptions
  ): Promise<ClaudeRateLimitAccountsState>
  reauthenticateAccount(accountId: string): Promise<ClaudeRateLimitAccountsState>
  removeAccount(accountId: string): Promise<ClaudeRateLimitAccountsState>
  selectAccount(accountId: string | null): Promise<ClaudeRateLimitAccountsState>
  selectAccountForTarget(
    accountId: string | null,
    target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }
  ): Promise<ClaudeRateLimitAccountsState>
  cancelPendingLogin(): boolean
  getRuntimeConfigDir(target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }): string
}

function createService(): ClaudeAccountService {
  const settings = {
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
  }
  return new ClaudeAccountService(
    { getSettings: () => settings, updateSettings: vi.fn() } as never,
    {} as never,
    { getRuntimeConfigDir: () => '/tmp/claude' } as never
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => (resolve = done)), resolve }
}

describe('ClaudeAccountService API parity', () => {
  it('keeps the exact runtime export and assignable public surface', async () => {
    const runtimeExports = await import('./service')
    const service: PublicClaudeAccountService = createService()

    expect(Object.keys(runtimeExports)).toEqual(['ClaudeAccountService'])
    expect(service.cancelPendingLogin()).toBe(false)
    expect(service.getRuntimeConfigDir()).toBe('/tmp/claude')
  })

  it('serializes mutations within one service', async () => {
    const service = createService()
    const first = deferred()
    const calls: string[] = []
    const registration = (
      service as unknown as {
        registration: {
          add(target?: ClaudeAccountAddTarget): Promise<ClaudeRateLimitAccountsState>
        }
      }
    ).registration
    registration.add = vi.fn(async (target) => {
      calls.push(target?.wslDistro ?? 'host')
      if (calls.length === 1) {
        await first.promise
      }
      return {
        accounts: [],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      }
    })

    const firstAdd = service.addAccount({ runtime: 'wsl', wslDistro: 'one' })
    const secondAdd = service.addAccount({ runtime: 'wsl', wslDistro: 'two' })
    await vi.waitFor(() => expect(calls).toEqual(['one']))
    first.resolve()
    await Promise.all([firstAdd, secondAdd])
    expect(calls).toEqual(['one', 'two'])
  })

  it('isolates mutation and cancellation state between runtime hosts', async () => {
    const firstService = createService()
    const secondService = createService()
    const first = deferred()
    const firstAdd = vi.fn(async () => {
      await first.promise
      return {
        accounts: [],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      }
    })
    const secondAdd = vi.fn(async () => ({
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    }))
    ;(firstService as unknown as { registration: { add: typeof firstAdd } }).registration.add =
      firstAdd
    ;(secondService as unknown as { registration: { add: typeof secondAdd } }).registration.add =
      secondAdd
    ;(
      firstService as unknown as { cancelPendingClaudeLogin: () => boolean }
    ).cancelPendingClaudeLogin = vi.fn(() => true)

    const pendingFirst = firstService.addAccount()
    await expect(secondService.addAccount()).resolves.toMatchObject({ accounts: [] })
    expect(firstService.cancelPendingLogin()).toBe(true)
    expect(secondService.cancelPendingLogin()).toBe(false)
    first.resolve()
    await pendingFirst
  })
})
