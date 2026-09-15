import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { applyAgentStatusHooksEnabledMock } = vi.hoisted(() => ({
  applyAgentStatusHooksEnabledMock: vi.fn()
}))

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))

import { RuntimeClientSettingsController } from './runtime-client-settings'
import { setManagedHookInstallDecisionResolver } from '../agent-hooks/managed-hook-install-policy'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'

function createStoreFake(overrides: Partial<GlobalSettings>) {
  let settings = createGlobalSettingsFixture({ workspaceDir: '/w', ...overrides })
  return {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    }
  }
}

describe('RuntimeClientSettingsController.update managed hook reconcile', () => {
  beforeEach(() => {
    applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
    setManagedHookInstallDecisionResolver(null)
  })

  afterEach(() => setManagedHookInstallDecisionResolver(null))

  it('suppresses the reconcile while the install is deferred', async () => {
    setManagedHookInstallDecisionResolver(() => ({ kind: 'defer', reason: 'onboarding-pending' }))
    const store = createStoreFake({ agentStatusHooksEnabled: true })
    const controller = new RuntimeClientSettingsController(store as never)

    const result = await controller.update({ agentStatusHooksEnabled: false })

    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
    // The preference itself still persists; only the disk mutation is skipped.
    expect(result.agentStatusHooksEnabled).toBe(false)
  })

  it('reconciles for an installation that is not deferring', async () => {
    const store = createStoreFake({ agentStatusHooksEnabled: true })
    const controller = new RuntimeClientSettingsController(store as never)

    await controller.update({ agentStatusHooksEnabled: false })

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledTimes(1)
  })
})
