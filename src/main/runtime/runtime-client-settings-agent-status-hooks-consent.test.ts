import { describe, expect, it, vi, beforeEach } from 'vitest'

const { applyAgentStatusHooksEnabledMock } = vi.hoisted(() => ({
  applyAgentStatusHooksEnabledMock: vi.fn()
}))

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))

vi.mock('../codex-accounts/codex-credential-mirror-consent-revocation', () => ({
  clearMirroredCodexCredentials: vi.fn()
}))

import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'

// Why: an absent agentStatusHooksEnabled (predates the setting, or a load path that dropped
// it) must never be read as enabled -- silently hooking into another tool's config needs an
// explicit opt-in, not an unset default (E1).
function makeController(overrides: Partial<GlobalSettings> = {}) {
  let settings = createGlobalSettingsFixture({ workspaceDir: '/w', ...overrides })
  delete (settings as Partial<GlobalSettings>).agentStatusHooksEnabled
  const store = {
    getSettings: () => settings,
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
  return new RuntimeClientSettingsController(store as never)
}

describe('RuntimeClientSettingsController agent status hooks fail-closed default', () => {
  beforeEach(() => {
    applyAgentStatusHooksEnabledMock.mockReset()
  })

  it('does not enter the install path when hooks are unset and a disabled-agent update arrives', async () => {
    const controller = makeController({ disabledTuiAgents: [] })

    await controller.update({ disabledTuiAgents: ['codex'] })

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledOnce()
    expect(applyAgentStatusHooksEnabledMock.mock.calls[0]?.[0]).toBe(false)
  })

  it('shouldContinue also treats unset hooks as disabled, not enabled', async () => {
    const controller = makeController({ disabledTuiAgents: [] })

    await controller.update({ disabledTuiAgents: ['codex'] })

    const options = applyAgentStatusHooksEnabledMock.mock.calls[0]?.[2] as {
      shouldContinue: (agent: string) => boolean
    }
    expect(options.shouldContinue('claude')).toBe(false)
  })
})
