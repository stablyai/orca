import { describe, expect, it, vi } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as NodeOs from 'node:os'
import { ProfileStateWriterError } from '../persistence/profile-state/profile-state-writer-errors'
import {
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => testState.fakeHomeDir
}))

describe('Codex account removal durability', () => {
  registerCodexAccountsTestHomes()

  async function setup(runtime: 'host' | 'wsl' = 'host') {
    const home = createManagedHome(testState.userDataDir, 'account-1', '', 'credential')
    const account = {
      id: 'account-1',
      email: 'user@example.test',
      managedHomePath: home,
      managedHomeRuntime: runtime,
      wslDistro: runtime === 'wsl' ? 'Ubuntu' : null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const store = createStore(
      createSettings({
        codexManagedAccounts: [account],
        activeCodexManagedAccountId: runtime === 'host' ? account.id : null,
        activeCodexManagedAccountIdsByRuntime: {
          host: runtime === 'host' ? account.id : null,
          wsl: runtime === 'wsl' ? { Ubuntu: account.id } : {}
        }
      })
    )
    await store.replaceCodexResetCreditAttemptLedgerAndFlush({
      version: 1,
      attempts: [
        {
          idempotencyKey: 'pending-key',
          state: 'providerPending',
          expectedScope: {
            target: { runtime, wslDistro: account.wslDistro },
            accountId: account.id,
            accountRevision: 1,
            offerRevision: 'offer'
          }
        }
      ]
    })
    const runtimeHome = createRuntimeHome()
    const lifecycle = { onHostSystemDefaultSelected: vi.fn() }
    const { CodexAccountService } = await import('./service')
    const makeService = (state = store) =>
      new CodexAccountService(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies the Store operations used by account selection and its ledger.
        state as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies account quota refresh and eviction operations.
        createRateLimits() as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies the runtime operations used by account removal.
        runtimeHome as never,
        lifecycle
      )
    return { home, account, store, runtimeHome, lifecycle, makeService, service: makeService() }
  }

  it('waits for account and ledger acknowledgement before changing runtime files or credentials', async () => {
    const { home, store, runtimeHome, service } = await setup()
    const gate = Promise.withResolvers<void>()
    const persist = store.updateCodexAccountStateAndFlush.getMockImplementation()!
    store.updateCodexAccountStateAndFlush.mockImplementationOnce(async (...args) => {
      await gate.promise
      await persist(...args)
    })
    const pending = service.removeAccount('account-1')
    await vi.waitFor(() => expect(store.updateCodexAccountStateAndFlush).toHaveBeenCalledOnce())
    expect(existsSync(home)).toBe(true)
    expect(runtimeHome.syncForCurrentSelection).not.toHaveBeenCalled()
    expect(store.getCodexResetCreditAttemptLedger().attempts).toHaveLength(1)
    gate.resolve()
    await expect(pending).resolves.toMatchObject({ accounts: [], pendingRemovals: [] })
    expect(existsSync(home)).toBe(false)
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
    expect(store.updateCodexAccountStateAndFlush).toHaveBeenCalledTimes(2)
  })

  it('preserves the account, credentials and credit guards on a known commit failure', async () => {
    const { home, account, store, runtimeHome, service } = await setup()
    store.updateCodexAccountStateAndFlush.mockRejectedValueOnce(new Error('disk full'))
    await expect(service.removeAccount(account.id)).rejects.toThrow('disk full')
    expect(store.getSettings().codexManagedAccounts).toEqual([account])
    expect(existsSync(home)).toBe(true)
    expect(runtimeHome.syncForCurrentSelection).not.toHaveBeenCalled()
    expect(store.getCodexResetCreditAttemptLedger().attempts).toHaveLength(1)
    await expect(service.removeAccount(account.id)).resolves.toMatchObject({ accounts: [] })
  })

  it('recovers a committed removal after its acknowledgement is lost', async () => {
    const { home, account, store, makeService, service } = await setup()
    const persist = store.updateCodexAccountStateAndFlush.getMockImplementation()!
    store.updateCodexAccountStateAndFlush.mockImplementationOnce(async (...args) => {
      await persist(...args)
      throw new ProfileStateWriterError('worker-exit', 'acknowledgement lost', 'indeterminate')
    })
    await expect(service.removeAccount(account.id)).rejects.toThrow('acknowledgement lost')
    expect(existsSync(home)).toBe(true)
    expect(service.listAccounts()).toMatchObject({
      accounts: [],
      pendingRemovals: [{ id: account.id }]
    })
    const recovered = makeService(createStore(structuredClone(store.getSettings())))
    await expect(recovered.selectAccount(account.id)).rejects.toThrow('no longer exists')
    await expect(recovered.reauthenticateAccount(account.id)).rejects.toThrow('no longer exists')
    expect(recovered.listAccounts()).toMatchObject({ accounts: [], pendingRemovals: [] })
    expect(existsSync(home)).toBe(false)
  })

  it.each(['host', 'wsl'] as const)(
    'keeps cleanup pending after a %s runtime synchronization failure',
    async (runtime) => {
      const { home, account, store, runtimeHome, lifecycle, service } = await setup(runtime)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (runtime === 'host') {
        runtimeHome.syncForCurrentSelection.mockImplementationOnce(() => {
          throw new Error('runtime locked')
        })
      } else {
        runtimeHome.syncForCurrentSelection
          .mockImplementationOnce(() => {})
          .mockImplementationOnce(() => {
            throw new Error('WSL unavailable')
          })
      }
      await expect(service.removeAccount(account.id)).resolves.toMatchObject({
        accounts: [],
        pendingRemovals: [{ id: account.id }]
      })
      expect(existsSync(home)).toBe(true)
      expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
      await expect(service.removeAccount(account.id)).resolves.toMatchObject({
        pendingRemovals: []
      })
      if (runtime === 'wsl') {
        expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({
          runtime: 'wsl',
          wslDistro: 'Ubuntu'
        })
        expect(lifecycle.onHostSystemDefaultSelected).not.toHaveBeenCalled()
      } else {
        expect(lifecycle.onHostSystemDefaultSelected).toHaveBeenCalledOnce()
      }
    }
  )

  it('retries a refused cleanup at startup and clears it when ownership can be proven', async () => {
    const { home, account, store, makeService, service } = await setup()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(home, '.orca-managed-home'), 'different-owner\n')
    await expect(service.removeAccount(account.id)).resolves.toMatchObject({
      pendingRemovals: [{ id: account.id, removalPending: true }]
    })
    expect(existsSync(home)).toBe(true)
    const recovered = makeService(createStore(structuredClone(store.getSettings())))
    writeFileSync(join(home, '.orca-managed-home'), `${account.id}\n`)
    await vi.waitFor(() => expect(existsSync(home)).toBe(false))
    expect(recovered.listAccounts()).toMatchObject({ pendingRemovals: [] })
  })

  it('finishes recovery when credentials were deleted but clearing the record failed', async () => {
    const { home, account, store, makeService, service } = await setup()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const persist = store.updateCodexAccountStateAndFlush.getMockImplementation()!
    store.updateCodexAccountStateAndFlush
      .mockImplementationOnce(persist)
      .mockRejectedValueOnce(new Error('disk full'))
    await expect(service.removeAccount(account.id)).resolves.toMatchObject({
      pendingRemovals: [{ id: account.id }]
    })
    expect(existsSync(home)).toBe(false)
    const recovered = makeService(createStore(structuredClone(store.getSettings())))
    await vi.waitFor(() => expect(recovered.listAccounts().pendingRemovals).toEqual([]))
    expect(existsSync(home)).toBe(false)
  })

  it('runs the host default lifecycle when host sync clears a stale selection during WSL removal', async () => {
    const { store, account, runtimeHome, lifecycle, service } = await setup('wsl')
    store.updateSettings({
      activeCodexManagedAccountId: 'stale-host',
      activeCodexManagedAccountIdsByRuntime: { host: 'stale-host', wsl: { Ubuntu: account.id } }
    })
    runtimeHome.syncForCurrentSelection.mockImplementationOnce(() => {
      store.updateSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    })
    await service.removeAccount(account.id)
    expect(lifecycle.onHostSystemDefaultSelected).toHaveBeenCalledOnce()
  })
})
