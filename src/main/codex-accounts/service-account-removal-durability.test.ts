import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { ProfileStateWriterError } from '../persistence/profile-state/profile-state-writer-errors'
import {
  createManagedHome,
  failNextAccountRemovalPersistence,
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

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('Codex account removal durability', () => {
  registerCodexAccountsTestHomes()

  it('keeps a removal target discoverable after a committed write loses its acknowledgement', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath,
            managedHomeRuntime: 'host',
            wslDistro: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1'
      })
    )
    const persist = store.updateCodexAccountSettingsAndResetLedgerAndFlush.getMockImplementation()!
    store.updateCodexAccountSettingsAndResetLedgerAndFlush.mockImplementationOnce(
      async (updates, next) => {
        await persist(updates, next)
        throw new ProfileStateWriterError(
          'test-worker-exit',
          'acknowledgement lost',
          'indeterminate'
        )
      }
    )
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture implements removal's Store operations.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies removal's refresh and eviction methods.
      createRateLimits() as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies runtime reconciliation used by removal.
      createRuntimeHome() as never
    )
    await expect(service.removeAccount('account-1')).rejects.toThrow('acknowledgement lost')
    expect(existsSync(managedHomePath)).toBe(true)
    expect(service.listAccounts().accounts).toMatchObject([
      { id: 'account-1', removalPending: true }
    ])

    const reloaded = createStore(structuredClone(store.getSettings()))
    const recovered = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Reloaded fixture implements removal's Store operations.
      reloaded as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies removal's refresh and eviction methods.
      createRateLimits() as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies runtime reconciliation used by removal.
      createRuntimeHome() as never
    )
    await expect(recovered.selectAccount('account-1')).rejects.toThrow('no longer exists')
    await expect(recovered.removeAccount('account-1')).resolves.toMatchObject({ accounts: [] })
    expect(existsSync(managedHomePath)).toBe(false)
  })

  it('keeps managed credentials until asynchronous account and ledger persistence acknowledges', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath,
            managedHomeRuntime: 'host',
            wslDistro: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1'
      })
    )
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const persist = store.updateCodexAccountSettingsAndResetLedgerAndFlush.getMockImplementation()!
    store.updateCodexAccountSettingsAndResetLedgerAndFlush.mockImplementationOnce(
      async (updates, next) => {
        started.resolve()
        await gate.promise
        await persist(updates, next)
      }
    )
    const rateLimits = createRateLimits()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture implements removal's Store operations.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies removal's refresh and eviction methods.
      rateLimits as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies runtime reconciliation used by removal.
      createRuntimeHome() as never
    )
    const removing = service.removeAccount('account-1')
    await started.promise
    expect(existsSync(managedHomePath)).toBe(true)
    expect(rateLimits.evictInactiveCodexCache).not.toHaveBeenCalled()
    gate.resolve()
    await expect(removing).resolves.toMatchObject({ accounts: [] })
    expect(existsSync(managedHomePath)).toBe(false)
  })

  it('keeps account removal retryable when runtime reconciliation fails', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          managedHomeRuntime: 'host',
          wslDistro: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const observedSelections: (string | null)[] = []
    let failReconciliation = true
    const runtimeHome = createRuntimeHome()
    runtimeHome.syncForCurrentSelection.mockImplementation(() => {
      observedSelections.push(store.getSettings().activeCodexManagedAccountId)
      if (failReconciliation) {
        failReconciliation = false
        throw new Error('activation failed')
      }
    })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture implements the Store operations exercised by removal.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies removal's refresh and eviction methods.
      createRateLimits() as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies runtime reconciliation used by removal.
      runtimeHome as never
    )

    await expect(service.removeAccount('account-1')).rejects.toThrow('activation failed')
    expect(observedSelections).toEqual([null, 'account-1'])
    expect(store.getSettings().codexManagedAccounts.map(({ id }) => id)).toEqual(['account-1'])
    expect(existsSync(managedHomePath)).toBe(true)

    await expect(service.removeAccount('account-1')).resolves.toMatchObject({ accounts: [] })
    expect(existsSync(managedHomePath)).toBe(false)
  })

  it('rolls removal back when runtime reconciliation tries to mutate unrelated preview settings', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          managedHomeRuntime: 'host',
          wslDistro: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const runtimeHome = createRuntimeHome()
    runtimeHome.syncForCurrentSelection.mockImplementationOnce(() => {
      store.updateSettings({ uiLanguage: 'ja' })
    })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture implements the Store operations exercised by removal.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies removal's refresh and eviction methods.
      createRateLimits() as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies runtime reconciliation used by removal.
      runtimeHome as never
    )

    await expect(service.removeAccount('account-1')).rejects.toThrow(
      'Cannot update settings during a Codex account settings preview'
    )
    expect(store.getSettings().codexManagedAccounts.map(({ id }) => id)).toEqual(['account-1'])
    expect(existsSync(managedHomePath)).toBe(true)
    expect(store.updateCodexAccountSettingsAndResetLedgerAndFlush).not.toHaveBeenCalled()
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(2)

    await expect(service.removeAccount('account-1')).resolves.toMatchObject({ accounts: [] })
    expect(existsSync(managedHomePath)).toBe(false)
  })

  it('prunes a stale next selection in the same removal commit', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          managedHomeRuntime: 'host',
          wslDistro: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'missing-account',
      activeCodexManagedAccountIdsByRuntime: {
        host: 'missing-account',
        wsl: { Ubuntu: 'missing-wsl-account' }
      }
    })
    const store = createStore(settings)
    const runtimeHome = createRuntimeHome()
    runtimeHome.syncForCurrentSelection.mockImplementation(() => {
      const current = store.getSettings().activeCodexManagedAccountIdsByRuntime ?? {
        host: null,
        wsl: {}
      }
      if (current.host === 'missing-account') {
        store.updateSettings({
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: current.wsl }
        })
      }
    })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture implements the Store operations exercised by removal.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies removal's refresh and eviction methods.
      createRateLimits() as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies runtime reconciliation used by removal.
      runtimeHome as never
    )

    await expect(service.removeAccount('account-1')).resolves.toMatchObject({
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
    })
    expect(existsSync(managedHomePath)).toBe(false)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({ runtime: 'host' })
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
  })

  it('restores the selected account when account removal persistence fails', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          managedHomeRuntime: 'host',
          wslDistro: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const observedSelections: (string | null)[] = []
    const runtimeHome = createRuntimeHome()
    runtimeHome.syncForCurrentSelection.mockImplementation(() => {
      observedSelections.push(store.getSettings().activeCodexManagedAccountId)
    })
    failNextAccountRemovalPersistence(store)
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture implements the Store operations exercised by removal.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies removal's refresh and eviction methods.
      createRateLimits() as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies runtime reconciliation used by removal.
      runtimeHome as never
    )

    await expect(service.removeAccount('account-1')).rejects.toThrow('disk full')

    expect(observedSelections).toEqual([null, 'account-1'])
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(existsSync(managedHomePath)).toBe(true)
  })
})
