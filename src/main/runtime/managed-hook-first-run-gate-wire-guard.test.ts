import { describe, expect, it, vi, beforeEach } from 'vitest'

const { applyAgentStatusHooksEnabledMock } = vi.hoisted(() => ({
  applyAgentStatusHooksEnabledMock: vi.fn()
}))

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))

import {
  RuntimeClientSettingsController,
  type RuntimeClientSettingsUpdate
} from './runtime-client-settings'
import { SettingsUpdate } from './rpc/methods/client-settings-schemas'
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

describe('managedAgentHookFirstRunGate stays host-private', () => {
  beforeEach(() => {
    applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
  })

  it('is never published in the paired-client projection', () => {
    const store = createStoreFake({ managedAgentHookFirstRunGate: 'pending' })
    const projected = new RuntimeClientSettingsController(store as never).get()

    expect(Object.keys(projected)).not.toContain('managedAgentHookFirstRunGate')
  })

  it('is rejected by the strict client SettingsUpdate schema', () => {
    expect(() => SettingsUpdate.parse({ managedAgentHookFirstRunGate: 'done' })).toThrow()
  })

  it('has no slot in the client update union', () => {
    const update: RuntimeClientSettingsUpdate = {
      // @ts-expect-error the latch is main-owned and must never be client-writable
      managedAgentHookFirstRunGate: 'done'
    }

    expect(update).toBeTruthy()
  })
})

describe('RuntimeClientSettingsController.update managed hook reconcile', () => {
  beforeEach(() => {
    applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
  })

  it('suppresses the reconcile while the first-run latch is still armed', async () => {
    const store = createStoreFake({
      managedAgentHookFirstRunGate: 'pending',
      agentStatusHooksEnabled: true
    })
    const controller = new RuntimeClientSettingsController(store as never)

    const result = await controller.update({ agentStatusHooksEnabled: false })

    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
    // The preference itself still persists; only the disk mutation is skipped.
    expect(result.agentStatusHooksEnabled).toBe(false)
  })

  it('reconciles once the latch has been retired', async () => {
    const store = createStoreFake({
      managedAgentHookFirstRunGate: 'done',
      agentStatusHooksEnabled: true
    })
    const controller = new RuntimeClientSettingsController(store as never)

    await controller.update({ agentStatusHooksEnabled: false })

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledTimes(1)
  })
})
