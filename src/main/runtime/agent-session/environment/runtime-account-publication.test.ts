import { expect, it, vi } from 'vitest'
import { RateLimitService } from '../../../rate-limits/service/rate-limit-service'
import { okProvider } from '../../../rate-limits/service/rate-limit-service-test-harness'
import {
  RuntimeAccountController,
  type AccountsSnapshot,
  type RuntimeAccountServices
} from './runtime-account-controller'
import { subscribeRuntimeAccountChanges } from './runtime-account-change-subscription'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../../rpc/core'
import { ACCOUNT_METHODS } from '../../rpc/methods/accounts/accounts'
import { ACCOUNT_SUBSCRIPTION_METHOD } from '../../rpc/methods/accounts/account-subscription-method'

vi.mock('../../../../shared/app-lifecycle/app-environment', () => ({
  hasAppEnvironment: () => false
}))
vi.mock('../../../managed-data-accounts/service', () => ({
  getManagedDataAccountService: vi.fn()
}))
vi.mock('../../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: async () => false
}))
vi.mock('../../../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: async () => false
}))
vi.mock('../../../zcode/zcode-plan-api-key-store', () => ({
  hasZcodePlanApiKey: async () => false
}))

class AccountPublicationService extends RateLimitService {
  readonly nextReading = Promise.withResolvers<void>()

  change(provider: 'claude' | 'codex', value: number): void {
    this.updateState({ ...this.state, [provider]: okProvider(provider, value) })
  }

  protected override async fetchCodexOnly(): Promise<void> {
    await this.nextReading.promise
    this.change('codex', 12)
  }

  protected override async fetchClaudeOnly(): Promise<void> {
    await this.nextReading.promise
    this.change('claude', 12)
  }
}

it.each(['accounts.list', 'accounts.subscribe'] as const)(
  '%s reads a coherent initial snapshot when an account switch finishes during the roster read',
  async (method) => {
    const service = new AccountPublicationService()
    const controller = new RuntimeAccountController()
    const accountA = { accounts: [], activeAccountId: 'A' }
    const accountB = { accounts: [], activeAccountId: 'B' }
    let accounts = accountA
    let subscribed = false
    const rosterEntered = Promise.withResolvers<void>()
    const resumeRoster = Promise.withResolvers<void>()
    const listAccounts = vi
      .fn(async () => accounts)
      .mockImplementationOnce(async () => {
        const captured = accounts
        rosterEntered.resolve()
        await resumeRoster.promise
        return captured
      })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller uses only roster, rename subscriptions and the real usage service.
    controller.setServices({
      claudeAccounts: { listAccounts: () => accounts, onAccountRenamed: () => () => {} },
      codexAccounts: { listAccounts, onAccountRenamed: () => () => {} },
      rateLimits: service
    } as unknown as RuntimeAccountServices)
    const cleanups = new Map<string, () => void>()
    const abort = new AbortController()
    const ready = Promise.withResolvers<unknown>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the account RPC methods' runtime seams; change delivery remains pending during the initial read.
    const runtime = {
      getAccountsSnapshot: () => controller.getSnapshot(),
      getAccountsStreamSnapshot: () => {
        if (!subscribed) {
          throw new Error('The stream must subscribe before reading its initial snapshot')
        }
        return controller.getStreamSnapshot()
      },
      onAccountsChanged: () => {
        subscribed = true
        return () => {
          subscribed = false
        }
      },
      registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
      cleanupSubscription: (id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      },
      refreshAccountsForMobileSubscriber: async () => {}
    } as unknown as OrcaRuntimeService
    service.change('codex', 90)
    const list = eraseRpcMethods(ACCOUNT_METHODS).find(
      (candidate) => candidate.name === 'accounts.list'
    )
    if (!list || isStreamingMethod(list)) {
      throw new Error('Missing accounts.list request method')
    }
    const streaming = method === 'accounts.subscribe'
    const pending = streaming
      ? ACCOUNT_SUBSCRIPTION_METHOD.handler(
          undefined,
          { runtime, signal: abort.signal },
          (event) => {
            if (
              event &&
              typeof event === 'object' &&
              'type' in event &&
              event.type === 'ready' &&
              'snapshot' in event
            ) {
              ready.resolve(event.snapshot)
            }
          }
        )
      : list.handler({}, { runtime })
    try {
      await rosterEntered.promise
      accounts = accountB
      const switching = service.refreshForCodexAccountChange('A')
      service.nextReading.resolve()
      await switching
      resumeRoster.resolve()
      const snapshot = streaming ? await ready.promise : await pending
      expect(snapshot).toMatchObject({
        claude: { activeAccountId: 'B' },
        codex: { activeAccountId: 'B' },
        rateLimits: { codex: { session: { usedPercent: 12 } } }
      })
    } finally {
      abort.abort()
      await pending
      service.stop()
    }
  }
)

it.each(['claude', 'codex'] as const)(
  'drops %s usage built before a switch even when delivery resumes after it',
  async (provider) => {
    const service = new AccountPublicationService()
    const roster = (id: string) => ({
      activeAccountId: id,
      accounts: [
        {
          id,
          email: `${id}@example.com`,
          authMethod: 'subscription-oauth' as const,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const accountA = roster('A')
    const accountB = roster('B')
    let accounts = accountA
    const listCodexAccounts = vi.fn<() => Promise<AccountsSnapshot['codex']>>(async () => accounts)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only roster and subscription seams are used.
    const services = {
      rateLimits: service,
      claudeAccounts: { listAccounts: () => accounts, onAccountRenamed: () => () => {} },
      codexAccounts: { listAccounts: listCodexAccounts, onAccountRenamed: () => () => {} }
    } as unknown as RuntimeAccountServices
    const received: AccountsSnapshot[] = []
    const initial = Promise.withResolvers<void>()
    const latest = Promise.withResolvers<void>()
    const unsubscribe = subscribeRuntimeAccountChanges(
      services,
      { stream: vi.fn(), dataAccounts: () => ({}) },
      (snapshot) => {
        received.push(snapshot)
        initial.resolve()
        if (snapshot.rateLimits[provider]?.session?.usedPercent === 12) {
          latest.resolve()
        }
      }
    )
    service.change(provider, 90)
    await initial.promise

    const constructed = Promise.withResolvers<void>()
    const getState = service.getState.bind(service)
    const stateSpy = vi.spyOn(service, 'getState').mockImplementationOnce(async () => {
      const snapshot = await getState()
      // Queue the switch before the publisher can receive this completed A snapshot.
      constructed.resolve()
      return snapshot
    })
    const switching = constructed.promise.then(() => {
      accounts = accountB
      return provider === 'claude'
        ? service.refreshForClaudeAccountChange('A')
        : service.refreshForCodexAccountChange('A')
    })
    const rosterEntered = Promise.withResolvers<void>()
    const rosterRead = Promise.withResolvers<AccountsSnapshot['codex']>()
    listCodexAccounts.mockImplementationOnce(() => {
      rosterEntered.resolve()
      return rosterRead.promise
    })
    const cleared = Promise.withResolvers<void>()
    const refreshed = Promise.withResolvers<void>()
    const unsubscribeUsage = service.onStateChange((state) => {
      if (!state[provider]?.session) {
        cleared.resolve()
      } else if (state[provider]?.session?.usedPercent === 12) {
        refreshed.resolve()
      }
    })
    try {
      service.change(provider, 90)
      await rosterEntered.promise
      await cleared.promise
      service.nextReading.resolve()
      await switching
      await refreshed.promise
      rosterRead.resolve(accountB)
      await latest.promise
      expect(
        received.map((snapshot) => ({
          claude: snapshot.claude,
          codex: snapshot.codex,
          quota: snapshot.rateLimits[provider]?.session?.usedPercent ?? null
        }))
      ).toEqual([
        { claude: accountA, codex: accountA, quota: 90 },
        { claude: accountB, codex: accountB, quota: null },
        { claude: accountB, codex: accountB, quota: 12 }
      ])
    } finally {
      unsubscribe()
      unsubscribeUsage()
      stateSpy.mockRestore()
      service.stop()
    }
  }
)
