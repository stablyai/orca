import { describe, expect, it, vi } from 'vitest'
import { MuseSparkAccountService } from './service'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings, MuseSparkManagedAccount } from '../../shared/types'

function createStore(overrides: Partial<GlobalSettings> = {}) {
  let settings: GlobalSettings = { ...getDefaultSettings('/home/test'), ...overrides }
  return {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
}

function account(id: string): MuseSparkManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

describe('MuseSparkAccountService', () => {
  it('lists an empty roster by default (discovery is stubbed)', () => {
    const store = createStore()
    const service = new MuseSparkAccountService(store as never)
    expect(service.listAccounts()).toEqual({
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    })
  })

  it('selects a persisted account and mirrors it into the runtime selection', async () => {
    const store = createStore({ museSparkManagedAccounts: [account('a')] })
    const service = new MuseSparkAccountService(store as never)
    const state = await service.selectAccount('a')
    expect(state.activeAccountId).toBe('a')
    expect(state.activeAccountIdsByRuntime).toEqual({ host: 'a', wsl: {} })
  })

  it('rejects selecting an unknown account', async () => {
    const store = createStore()
    const service = new MuseSparkAccountService(store as never)
    await expect(service.selectAccount('missing')).rejects.toThrow('no longer exists')
  })

  it('removing the active account clears the selection', async () => {
    const store = createStore({
      museSparkManagedAccounts: [account('a')],
      activeMuseSparkManagedAccountId: 'a',
      activeMuseSparkManagedAccountIdsByRuntime: { host: 'a', wsl: {} }
    })
    const service = new MuseSparkAccountService(store as never)
    const state = await service.removeAccount('a')
    expect(state.accounts).toHaveLength(0)
    expect(state.activeAccountId).toBeNull()
  })

  it('normalizes a dangling active id whose account no longer exists', () => {
    const store = createStore({
      museSparkManagedAccounts: [],
      activeMuseSparkManagedAccountId: 'ghost',
      activeMuseSparkManagedAccountIdsByRuntime: { host: 'ghost', wsl: {} }
    })
    const service = new MuseSparkAccountService(store as never)
    expect(service.listAccounts().activeAccountId).toBeNull()
  })
})
