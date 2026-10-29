import { describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { SettingsUpdate } from '../../shared/rpc-contract/client-settings-params'
import { RuntimeClientSettingsController } from './runtime-client-settings'

vi.mock('../claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))

describe('the Codex history-sharing host setting', () => {
  it('is always published, so clients can tell this host accepts it', async () => {
    const settings = createGlobalSettingsFixture({ workspaceDir: '/w' })
    const store = {
      getSettings: () => settings,
      updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates)
    }
    const controller = new RuntimeClientSettingsController(store)
    expect(controller.get().codexShareHistoryAcrossAccounts).toBe(true)

    await controller.update(SettingsUpdate.parse({ codexShareHistoryAcrossAccounts: false }))

    expect(settings.codexShareHistoryAcrossAccounts).toBe(false)
    expect(controller.get().codexShareHistoryAcrossAccounts).toBe(false)
  })

  it('is accepted by a paired client update; unknown keys still are not', () => {
    expect(SettingsUpdate.parse({ codexShareHistoryAcrossAccounts: true })).toEqual({
      codexShareHistoryAcrossAccounts: true
    })
    expect(() => SettingsUpdate.parse({ codexShareHistoryAcrossAccount: true })).toThrow()
  })
})
