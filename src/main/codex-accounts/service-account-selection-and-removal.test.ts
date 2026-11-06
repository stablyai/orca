import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCodexAuthJson,
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexAccountService config sync', () => {
  registerCodexAccountsTestHomes()

  it('selectAccount switches managed accounts without routing auth through the shared mirror', async () => {
    const firstAuth = createCodexAuthJson('one@example.com', 'acct-one', 'one')
    const secondAuth = createCodexAuthJson('two@example.com', 'acct-two', 'two')
    const firstManagedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      firstAuth
    )
    const secondManagedHomePath = createManagedHome(
      testState.userDataDir,
      'account-2',
      '',
      secondAuth
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: firstManagedHomePath,
          providerAccountId: 'acct-one',
          workspaceLabel: null,
          workspaceAccountId: 'acct-one',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'two@example.com',
          managedHomePath: secondManagedHomePath,
          providerAccountId: 'acct-two',
          workspaceLabel: null,
          workspaceAccountId: 'acct-two',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const runtimeHome = new CodexRuntimeHomeService(store as never)
    const runtimeAuthPath = join(testState.userDataDir, 'codex-runtime-home', 'home', 'auth.json')
    expect(existsSync(runtimeAuthPath)).toBe(false)

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await service.selectAccount('account-2')

    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(readFileSync(join(firstManagedHomePath, 'auth.json'), 'utf-8')).toBe(firstAuth)
    expect(readFileSync(join(secondManagedHomePath, 'auth.json'), 'utf-8')).toBe(secondAuth)
    expect(existsSync(join(testState.userDataDir, 'codex-runtime-home', 'launch'))).toBe(false)
    expect(existsSync(join(testState.userDataDir, 'codex-runtime-home', 'active'))).toBe(false)
  })

  it.each(['healthy', 'unreadable'])(
    'removes an account with a %s credit ledger',
    async (ledger) => {
      const managedHomePath = createManagedHome(
        testState.userDataDir,
        'account-1',
        '',
        '{"account":"managed"}\n'
      )
      const settings = createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath,
            providerAccountId: null,
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1'
      })
      const store = createStore(settings)
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()

      const ledgerError = new Error('credit ledger unreadable')
      if (ledger === 'unreadable') {
        store.getCodexResetCreditAttemptLedger.mockImplementation(() => {
          throw ledgerError
        })
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const result = await service.removeAccount('account-1')

      expect(result.accounts).toHaveLength(0)
      expect(result.activeAccountId).toBe(null)
      expect(existsSync(managedHomePath)).toBe(false)
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
      expect(rateLimits.evictInactiveCodexCache).toHaveBeenCalledWith('account-1')
      if (ledger === 'unreadable') {
        expect(warn).toHaveBeenCalledWith(
          '[codex-accounts] Removed account, but credit ledger cleanup failed:',
          expect.any(Error)
        )
        expect(store.replaceCodexResetCreditAttemptLedgerAndFlush).not.toHaveBeenCalled()
      }
      warn.mockRestore()
    }
  )

  it('refuses to remove a managed home owned by a different account', async () => {
    const otherAccountHome = createManagedHome(
      testState.userDataDir,
      'account-2',
      '',
      '{"account":"other"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath: otherAccountHome,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      createRateLimits() as never,
      createRuntimeHome() as never
    )

    await service.removeAccount('account-1')

    expect(readFileSync(join(otherAccountHome, 'auth.json'), 'utf-8')).toBe('{"account":"other"}\n')
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-accounts] Refusing to remove untrusted managed home:',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })
})
