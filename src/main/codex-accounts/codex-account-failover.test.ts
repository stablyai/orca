import { describe, expect, it, vi } from 'vitest'
import { createCodexAccountSettings } from './codex-account-settings-fixture'
import { failoverCodexAccount } from './codex-account-failover'

describe('serialized account failover', () => {
  function fixture() {
    const a = {
      id: 'a',
      email: 'a@example.test',
      managedHomePath: '/a',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const b = { ...a, id: 'b', managedHomePath: '/b' }
    const settings = createCodexAccountSettings('/workspace', {
      codexManagedAccounts: [a, b],
      codexAutomaticFailover: true,
      activeCodexManagedAccountId: 'a',
      activeCodexManagedAccountIdsByRuntime: { host: 'a', wsl: {} }
    })
    let generation = 0
    const controller = new AbortController()
    const migrate = vi.fn(async () => {})
    const select = vi.fn(async () => {})
    const input = { home: '/a', signal: controller.signal, isSafe: () => true, migrate }
    const deps = {
      settings: () => settings,
      generation: () => generation,
      findReplacement: vi.fn(async () => b),
      serialize: async (operation: () => Promise<boolean>) => operation(),
      select
    }
    return {
      input,
      deps,
      settings,
      migrate,
      select,
      controller,
      manual: () => {
        generation++
      }
    }
  }
  it('migrates before changing the default', async () => {
    const f = fixture()
    f.select.mockImplementation(async () => {
      expect(f.migrate).toHaveBeenCalledOnce()
    })
    expect(await failoverCodexAccount(f.input, f.deps)).toBe(true)
    expect(f.select).toHaveBeenCalledOnce()
  })
  it.each(['manual', 'removed', 'disabled', 'unsafe', 'aborted'] as const)(
    'does not migrate after %s changes during quota polling',
    async (change) => {
      const f = fixture()
      f.deps.findReplacement.mockImplementation(async () => {
        const candidate = f.settings.codexManagedAccounts[1]
        if (change === 'manual') {
          f.manual()
        }
        if (change === 'removed') {
          f.settings.codexManagedAccounts = []
        }
        if (change === 'disabled') {
          f.settings.codexAutomaticFailover = false
        }
        if (change === 'unsafe') {
          f.input.isSafe = () => false
        }
        if (change === 'aborted') {
          f.controller.abort()
        }
        return candidate
      })
      expect(await failoverCodexAccount(f.input, f.deps)).toBe(false)
      expect(f.migrate).not.toHaveBeenCalled()
      expect(f.select).not.toHaveBeenCalled()
    }
  )
  it('refuses quota that became stale while waiting for the selection transaction', async () => {
    const f = fixture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    f.deps.serialize = async (operation) => {
      clock.mockReturnValue(62_000)
      return operation()
    }
    try {
      expect(await failoverCodexAccount(f.input, f.deps)).toBe(false)
      expect(f.migrate).not.toHaveBeenCalled()
      expect(f.select).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
    }
  })
  it('does not change selection when migration cannot prove provider exit', async () => {
    const f = fixture()
    f.migrate.mockRejectedValue(new Error('unverifiable'))
    await expect(failoverCodexAccount(f.input, f.deps)).rejects.toThrow('unverifiable')
    expect(f.select).not.toHaveBeenCalled()
  })
  it('lets a manual selection queued during migration own the default', async () => {
    const f = fixture()
    f.migrate.mockImplementation(async () => {
      f.manual()
    })
    await expect(failoverCodexAccount(f.input, f.deps)).rejects.toThrow('superseded')
    expect(f.select).not.toHaveBeenCalled()
  })
})
