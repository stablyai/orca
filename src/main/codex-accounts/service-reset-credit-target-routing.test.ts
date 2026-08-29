import { describe, expect, it, vi } from 'vitest'
import { buildCodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import {
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'
import {
  createResetCreditLimits,
  createResetRateLimitState
} from './service-reset-credit-test-fixtures'

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

describe('CodexAccountService config sync', () => {
  registerCodexAccountsTestHomes()

  it('isolates a WSL reset to the selected distro account and immutable managed home', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-wsl')
    const account = {
      id: 'account-wsl',
      email: 'wsl@example.com',
      managedHomePath,
      managedHomeRuntime: 'wsl' as const,
      wslDistro: 'Ubuntu',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: account.id }
      }
    })
    const limits = createResetCreditLimits()
    const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    const state = createResetRateLimitState(limits, target)
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const expectedScope = buildCodexResetCreditExpectedScope({ target, account, limits })!
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      createRuntimeHome() as never
    )

    await expect(
      service.consumeRateLimitResetCredit('66666666-6666-4666-8666-666666666666', expectedScope)
    ).resolves.toMatchObject({ scope: expectedScope })
    expect(consume).toHaveBeenCalledWith({
      idempotencyKey: '66666666-6666-4666-8666-666666666666',
      target,
      codexHomePath: managedHomePath
    })
  })

  it('keeps a restarted pending WSL attempt isolated from another distro', async () => {
    const ubuntuHome = createManagedHome(testState.userDataDir, 'account-ubuntu')
    const debianHome = createManagedHome(testState.userDataDir, 'account-debian')
    const ubuntu = {
      id: 'account-ubuntu',
      email: 'ubuntu@example.com',
      managedHomePath: ubuntuHome,
      managedHomeRuntime: 'wsl' as const,
      wslDistro: 'Ubuntu',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const debian = {
      ...ubuntu,
      id: 'account-debian',
      email: 'debian@example.com',
      managedHomePath: debianHome,
      wslDistro: 'Debian',
      updatedAt: 2
    }
    const settings = createSettings({
      codexManagedAccounts: [ubuntu, debian],
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: ubuntu.id, Debian: debian.id }
      }
    })
    const limits = createResetCreditLimits()
    const ubuntuTarget = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    const debianTarget = { runtime: 'wsl' as const, wslDistro: 'Debian' }
    const state = createResetRateLimitState(limits, ubuntuTarget)
    const ubuntuScope = buildCodexResetCreditExpectedScope({
      target: ubuntuTarget,
      account: ubuntu,
      limits
    })!
    const debianScope = buildCodexResetCreditExpectedScope({
      target: debianTarget,
      account: debian,
      limits
    })!
    const store = createStore(settings)
    const { CodexAccountService } = await import('./service')
    const firstService = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: vi
          .fn()
          .mockRejectedValue(new Error('Ubuntu response lost'))
      } as never,
      createRuntimeHome() as never
    )
    await expect(
      firstService.consumeRateLimitResetCredit('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ubuntuScope)
    ).rejects.toThrow('Ubuntu response lost')

    state.codexTarget = debianTarget
    const debianConsume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const restarted = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: debianConsume
      } as never,
      createRuntimeHome() as never
    )

    await expect(
      restarted.consumeRateLimitResetCredit('ffffffff-ffff-4fff-8fff-ffffffffffff', debianScope)
    ).resolves.toMatchObject({ outcome: 'reset', scope: debianScope })
    expect(debianConsume).toHaveBeenCalledWith({
      idempotencyKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      target: debianTarget,
      codexHomePath: debianHome
    })
  })

  it('preserves desktop reset support for the system-default Codex account', async () => {
    const settings = createSettings()
    const state = createResetRateLimitState(createResetCreditLimits())
    const consume = vi.fn().mockResolvedValue({ outcome: 'noCredit', state })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const runtimeHome = createRuntimeHome()
    runtimeHome.prepareForRateLimitFetch.mockReturnValue({ kind: 'ready', codexHomePath: null })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      runtimeHome as never
    )

    await expect(service.consumeCurrentRateLimitResetCredit()).resolves.toMatchObject({
      outcome: 'noCredit'
    })
    expect(runtimeHome.prepareForRateLimitFetch).toHaveBeenCalledWith({
      runtime: 'host',
      wslDistro: null
    })
    expect(consume).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: null
    })
  })

  it('routes a managed desktop reset through the durable coordinator', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const store = createStore(settings)
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )

    await expect(service.consumeCurrentRateLimitResetCredit()).resolves.toEqual({
      outcome: 'reset',
      state
    })
    expect(consume).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: managedHomePath
    })
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { state: 'settled', outcome: 'reset', expectedScope: { accountId: account.id } }
    ])
  })

  it('reuses the durable pending key when desktop retries a managed reset after restart', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const store = createStore(settings)
    const firstConsume = vi.fn().mockRejectedValue(new Error('provider response lost'))
    const { CodexAccountService } = await import('./service')
    const firstService = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: firstConsume
      } as never,
      createRuntimeHome() as never
    )

    await expect(firstService.consumeCurrentRateLimitResetCredit()).rejects.toThrow(
      'provider response lost'
    )
    const pending = store.getCodexResetCreditAttemptLedger().attempts[0]
    expect(pending).toMatchObject({
      state: 'providerPending',
      expectedScope: { accountId: account.id }
    })

    state.codex = {
      ...limits,
      updatedAt: limits.updatedAt + 1,
      rateLimitResetCredits: { ...limits.rateLimitResetCredits!, availableCount: 0 }
    }
    const replayConsume = vi.fn().mockResolvedValue({ outcome: 'alreadyRedeemed', state })
    const restarted = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: replayConsume
      } as never,
      createRuntimeHome() as never
    )

    await expect(restarted.consumeCurrentRateLimitResetCredit()).resolves.toEqual({
      outcome: 'alreadyRedeemed',
      state
    })
    expect(replayConsume).toHaveBeenCalledWith({
      idempotencyKey: pending?.idempotencyKey,
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: managedHomePath
    })
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { state: 'settled', outcome: 'alreadyRedeemed' }
    ])
  })

  it('blocks the system-default fallback while the exact target has a pending attempt', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: null
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    store.replaceCodexResetCreditAttemptLedgerAndFlush({
      version: 1,
      attempts: [
        {
          idempotencyKey: '12121212-1212-4212-8212-121212121212',
          expectedScope,
          state: 'providerPending'
        }
      ]
    })
    const consume = vi.fn()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )

    await expect(service.consumeCurrentRateLimitResetCredit()).rejects.toThrow('unknown outcome')
    expect(consume).not.toHaveBeenCalled()
  })

  it('unwedges the system-default reset after removing the account owning a pending attempt', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: null
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    store.replaceCodexResetCreditAttemptLedgerAndFlush({
      version: 1,
      attempts: [
        {
          idempotencyKey: '12121212-1212-4212-8212-121212121212',
          expectedScope,
          state: 'providerPending'
        }
      ]
    })
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )

    // The orphan pending attempt wedges the target-scoped default reset until removal.
    await expect(service.consumeCurrentRateLimitResetCredit()).rejects.toThrow('unknown outcome')

    await service.removeAccount('account-1')

    await expect(service.consumeCurrentRateLimitResetCredit()).resolves.toEqual({
      outcome: 'reset',
      state
    })
    expect(consume).toHaveBeenCalledTimes(1)
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
  })

  it('keeps reset attempts fail-closed when removal cannot persist their purge', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: null
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    store.replaceCodexResetCreditAttemptLedgerAndFlush({
      version: 1,
      attempts: [
        {
          idempotencyKey: '13131313-1313-4313-8313-131313131313',
          expectedScope,
          state: 'providerPending'
        }
      ]
    })
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )
    vi.spyOn(store, 'replaceCodexResetCreditAttemptLedgerAndFlush').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    await expect(service.removeAccount('account-1')).rejects.toThrow('disk full')
    await expect(service.consumeCurrentRateLimitResetCredit()).rejects.toThrow('unknown outcome')
    expect(consume).not.toHaveBeenCalled()
  })

  it('does not reset a different system-default target after waiting in the mutation queue', async () => {
    const settings = createSettings()
    const state = createResetRateLimitState(createResetCreditLimits())
    let finishRefresh: (() => void) | undefined
    const consume = vi.fn()
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume,
      refreshForCodexAccountChange: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRefresh = resolve
          })
      )
    }
    const runtimeHome = createRuntimeHome()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      runtimeHome as never
    )

    const queueBlocker = service.selectAccount(null)
    await vi.waitFor(() => expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledOnce())
    const resetting = service.consumeCurrentRateLimitResetCredit()
    state.codexTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    finishRefresh?.()

    await queueBlocker
    await expect(resetting).rejects.toThrow('target changed')
    expect(consume).not.toHaveBeenCalled()
    expect(runtimeHome.prepareForRateLimitFetch).not.toHaveBeenCalled()
  })
})
