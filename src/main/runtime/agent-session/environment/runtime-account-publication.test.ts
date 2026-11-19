import { expect, it, vi } from 'vitest'
import { RateLimitService } from '../../../rate-limits/service/rate-limit-service'
import { okProvider } from '../../../rate-limits/service/rate-limit-service-test-harness'
import type { AccountsSnapshot, RuntimeAccountServices } from './runtime-account-controller'
import { subscribeRuntimeAccountChanges } from './runtime-account-change-subscription'

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
