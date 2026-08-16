import { describe, expect, it, vi } from 'vitest'
import type { RateLimitState } from '../../shared/rate-limit-types'
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

  it('validates a reset only after an earlier account switch leaves the mutation queue', async () => {
    const firstHome = createManagedHome(testState.userDataDir, 'account-1')
    const secondHome = createManagedHome(testState.userDataDir, 'account-2')
    const firstAccount = {
      id: 'account-1',
      email: 'first@example.com',
      managedHomePath: firstHome,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [
        firstAccount,
        {
          ...firstAccount,
          id: 'account-2',
          email: 'second@example.com',
          managedHomePath: secondHome,
          updatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    let finishRefresh: (() => void) | undefined
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: vi.fn(),
      refreshForCodexAccountChange: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRefresh = resolve
          })
      )
    }
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account: firstAccount,
      limits
    })!

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      createRuntimeHome() as never
    )
    const selecting = service.selectAccount('account-2')
    await vi.waitFor(() => expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledOnce())
    const resetting = service.consumeRateLimitResetCredit(
      '11111111-1111-4111-8111-111111111111',
      expectedScope
    )
    finishRefresh?.()

    await selecting
    await expect(resetting).resolves.toMatchObject({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'accountChanged',
      scope: expectedScope
    })
    expect(rateLimits.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled()
  })

  it('singleflights concurrent same-key reset attempts and forwards the approved home and target', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const nextManagedHomePath = createManagedHome(testState.userDataDir, 'account-2')
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
    const nextAccount = {
      ...account,
      id: 'account-2',
      email: 'next@example.com',
      managedHomePath: nextManagedHomePath,
      updatedAt: 2
    }
    const settings = createSettings({
      codexManagedAccounts: [account, nextAccount],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    let finishConsume: ((value: { outcome: 'reset'; state: RateLimitState }) => void) | undefined
    const consume = vi.fn(
      () =>
        new Promise<{ outcome: 'reset'; state: RateLimitState }>((resolve) => {
          finishConsume = resolve
        })
    )
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      createRuntimeHome() as never
    )
    const idempotencyKey = '22222222-2222-4222-8222-222222222222'

    const first = service.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    const second = service.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    expect(second).toBe(first)
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce())
    const selectingNextAccount = service.selectAccount(nextAccount.id)
    finishConsume?.({ outcome: 'reset', state })

    const resetResults = await Promise.all([first, second])
    expect(resetResults).toMatchObject([
      { outcome: 'reset', scope: expectedScope },
      { outcome: 'reset', scope: expectedScope }
    ])
    await selectingNextAccount
    expect(resetResults[0]?.codex.activeAccountId).toBe(account.id)
    expect(resetResults[0]?.rateLimits).toBe(state)
    expect(service.listAccounts().activeAccountId).toBe(nextAccount.id)
    expect(consume).toHaveBeenCalledWith({
      idempotencyKey,
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: managedHomePath
    })
    await expect(
      service.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    ).rejects.toThrow('selected Codex account changed')
    expect(consume).toHaveBeenCalledOnce()

    await service.selectAccount(account.id)
    const settledReplay = await service.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    expect(settledReplay).toMatchObject({
      outcome: 'reset',
      scope: expectedScope,
      codex: { activeAccountId: account.id }
    })
    expect(consume).toHaveBeenCalledOnce()
    await expect(
      service.consumeRateLimitResetCredit('77777777-7777-4777-8777-777777777777', expectedScope)
    ).rejects.toThrow('already attempted')
    await expect(
      service.consumeRateLimitResetCredit(idempotencyKey, {
        ...expectedScope,
        offerRevision: 'v1:different'
      })
    ).rejects.toThrow('different reset scope')
  })

  it('blocks a different key after an ambiguous provider error but lets desktop retry', async () => {
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
    const consume = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider response lost'))
      .mockResolvedValueOnce({ outcome: 'alreadyRedeemed', state })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      createRuntimeHome() as never
    )
    const firstKey = '33333333-3333-4333-8333-333333333333'

    await expect(service.consumeRateLimitResetCredit(firstKey, expectedScope)).rejects.toThrow(
      'provider response lost'
    )
    await expect(service.consumeCurrentRateLimitResetCredit()).resolves.toMatchObject({
      outcome: 'alreadyRedeemed',
      state
    })
    expect(consume).toHaveBeenCalledTimes(2)
    await expect(
      service.consumeRateLimitResetCredit('44444444-4444-4444-8444-444444444444', expectedScope)
    ).rejects.toThrow('already attempted')
    await expect(
      service.consumeRateLimitResetCredit(firstKey, expectedScope)
    ).resolves.toMatchObject({ outcome: 'alreadyRedeemed', scope: expectedScope })
    expect(consume).toHaveBeenCalledTimes(2)
  })

  it('hydrates a pending attempt after restart and replays it without current-offer CAS', async () => {
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
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
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
    const key = '88888888-8888-4888-8888-888888888888'

    await expect(firstService.consumeRateLimitResetCredit(key, expectedScope)).rejects.toThrow(
      'provider response lost'
    )
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

    await expect(
      restarted.consumeRateLimitResetCredit('99999999-9999-4999-8999-999999999999', expectedScope)
    ).rejects.toThrow('unknown outcome')
    await expect(
      restarted.consumeRateLimitResetCredit(key, {
        ...expectedScope,
        offerRevision: 'v1:different'
      })
    ).rejects.toThrow('different reset scope')
    await expect(restarted.consumeRateLimitResetCredit(key, expectedScope)).resolves.toMatchObject({
      outcome: 'alreadyRedeemed',
      scope: expectedScope
    })
    expect(replayConsume).toHaveBeenCalledOnce()
  })

  it('replays a settled outcome after restart without calling the provider', async () => {
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
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const firstConsume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
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
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await firstService.consumeRateLimitResetCredit(key, expectedScope)

    const replayConsume = vi.fn()
    const restarted = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: replayConsume
      } as never,
      createRuntimeHome() as never
    )

    await expect(restarted.consumeRateLimitResetCredit(key, expectedScope)).resolves.toMatchObject({
      outcome: 'reset',
      scope: expectedScope
    })
    await expect(
      restarted.consumeRateLimitResetCredit('abababab-abab-4bab-8bab-abababababab', expectedScope)
    ).rejects.toThrow('already attempted')
    expect(replayConsume).not.toHaveBeenCalled()
  })

  it('never calls the provider when the pending durability barrier fails', async () => {
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
    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const consume = vi.fn()
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
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

    await expect(
      service.consumeRateLimitResetCredit('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedScope)
    ).rejects.toThrow('disk full')
    expect(consume).not.toHaveBeenCalled()
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
  })

  it('keeps disk pending when settle persistence fails and recovers with the same key', async () => {
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
    const persist = store.replaceCodexResetCreditAttemptLedgerAndFlush.getMockImplementation()!
    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementation((ledger) => {
      if (ledger.attempts[0]?.state === 'settled') {
        throw new Error('settle disk full')
      }
      persist(ledger)
    })
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const firstConsume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
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
    const key = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    await expect(firstService.consumeRateLimitResetCredit(key, expectedScope)).rejects.toThrow(
      'settle disk full'
    )
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { idempotencyKey: key, state: 'providerPending' }
    ])

    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementation(persist)
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
    await expect(restarted.consumeRateLimitResetCredit(key, expectedScope)).resolves.toMatchObject({
      outcome: 'alreadyRedeemed'
    })
    expect(replayConsume).toHaveBeenCalledOnce()
  })

  it('fails only reset operations closed when the durable ledger is corrupt', async () => {
    const settings = createSettings()
    const store = createStore(settings)
    store.getCodexResetCreditAttemptLedger.mockImplementation(() => {
      throw new Error('Codex reset-credit attempt ledger is corrupt')
    })
    const consume = vi.fn()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )

    expect(service.listAccounts()).toMatchObject({ accounts: [] })
    await expect(
      service.consumeRateLimitResetCredit('dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
        target: { runtime: 'host', wslDistro: null },
        accountId: 'account-host',
        accountRevision: 1,
        offerRevision: 'v1:offer'
      })
    ).rejects.toThrow('Codex reset-credit attempt ledger is corrupt')
    await expect(service.consumeCurrentRateLimitResetCredit()).rejects.toThrow(
      'Codex reset-credit attempt ledger is corrupt'
    )
    expect(consume).not.toHaveBeenCalled()
  })

  it('rejects a stale offer scope before calling the provider and permits a corrected retry key', async () => {
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
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      createRuntimeHome() as never
    )
    const idempotencyKey = '55555555-5555-4555-8555-555555555555'

    await expect(
      service.consumeRateLimitResetCredit(idempotencyKey, {
        ...expectedScope,
        offerRevision: 'v1:stale'
      })
    ).resolves.toMatchObject({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope: { ...expectedScope, offerRevision: 'v1:stale' },
      codex: { activeAccountId: account.id },
      rateLimits: state
    })
    expect(consume).not.toHaveBeenCalled()

    await expect(
      service.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    ).resolves.toMatchObject({ outcome: 'reset' })
    expect(consume).toHaveBeenCalledOnce()
  })
})
