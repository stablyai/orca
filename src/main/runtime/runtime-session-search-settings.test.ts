import { describe, expect, it, vi } from 'vitest'
import {
  RuntimeSessionSearchSettingsController,
  type SessionSearchSettingsStore
} from './runtime-session-search-settings'
import type { GlobalSettings } from '../../shared/global-settings-types'

type Settings = ReturnType<SessionSearchSettingsStore['getSettings']>

function storeWith(aiVaultSearch: GlobalSettings['aiVaultSearch'] | undefined) {
  let settings: Settings = {
    workspaceDir: '/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    ...(aiVaultSearch ? { aiVaultSearch } : {})
  }
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    settings = { ...settings, ...updates }
  })
  const store: SessionSearchSettingsStore = {
    getSettings: () => settings,
    updateSettings
  }
  return { store, updateSettings, read: () => settings }
}

describe('runtime session search consent', () => {
  it('writes the whole policy and hands the host before/after exactly once', async () => {
    const { store, updateSettings, read } = storeWith({ enabled: false, historyDays: 30 })
    const apply = vi.fn()
    await new RuntimeSessionSearchSettingsController(store, apply).setEnabled(true)

    expect(updateSettings).toHaveBeenCalledExactlyOnceWith(
      { aiVaultSearch: { enabled: true, historyDays: 30 } },
      { notifyListeners: true }
    )
    // Retention must ride along untouched; a partial write would reset it to "all history".
    expect(read().aiVaultSearch).toEqual({ enabled: true, historyDays: 30 })
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ aiVaultSearch: { enabled: false, historyDays: 30 } }),
      expect.objectContaining({ aiVaultSearch: { enabled: true, historyDays: 30 } })
    )
  })

  it('normalizes an absent or malformed stored policy instead of writing it back', async () => {
    const { store, updateSettings } = storeWith(undefined)
    await new RuntimeSessionSearchSettingsController(store, null).setEnabled(true)

    expect(updateSettings).toHaveBeenCalledExactlyOnceWith(
      { aiVaultSearch: { enabled: true, historyDays: null } },
      { notifyListeners: true }
    )
  })

  it('hands the host an unchanged pair when the value did not move', async () => {
    const { store, updateSettings } = storeWith({ enabled: true, historyDays: null })
    const apply = vi.fn()
    await new RuntimeSessionSearchSettingsController(store, apply).setEnabled(true)

    // The write still happens; the host hook is what refuses to restart a live index.
    expect(updateSettings).toHaveBeenCalledOnce()
    const [before, after] = apply.mock.calls[0] ?? []
    expect(before?.aiVaultSearch).toEqual(after?.aiVaultSearch)
  })

  it('refuses on a host with no settings store rather than reporting success', async () => {
    await expect(
      new RuntimeSessionSearchSettingsController(null, vi.fn()).setEnabled(true)
    ).rejects.toThrow('runtime_unavailable')
  })
})
