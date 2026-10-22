/**
 * R42: a client turning status hooks off on a WSL host's orcad must not remove the hook entries
 * the WSL bridge's panes in the same distro still run on; anywhere else it removes them as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { RuntimeClientSettingsController } from './runtime-client-settings'

const mocks = vi.hoisted(() => ({
  apply: vi.fn(async () => []),
  wslHost: vi.fn(() => false)
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: mocks.apply
}))
vi.mock('../ipc/wsl-guest-windows-drive-path', () => ({
  isWslHostOrcadProcess: mocks.wslHost
}))

function controller(): RuntimeClientSettingsController {
  let settings = createGlobalSettingsFixture({ agentStatusHooksEnabled: true })
  return new RuntimeClientSettingsController({
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    },
    runDurableMutation: async (mutate) => mutate().value
  })
}

beforeEach(() => {
  mocks.apply.mockClear()
})

describe('turning status hooks off through a paired client', () => {
  it.each([
    [true, true],
    [false, false]
  ])('on a WSL host (%s) keeps the shared entries: %s', async (wslHost, keep) => {
    mocks.wslHost.mockReturnValue(wslHost)

    await controller().update({ agentStatusHooksEnabled: false })

    expect(mocks.apply).toHaveBeenCalledWith(
      false,
      expect.anything(),
      expect.objectContaining({ keepSharedEntries: keep })
    )
  })

  it('keeps them too when one agent is disabled on a WSL host', async () => {
    mocks.wslHost.mockReturnValue(true)

    await controller().update({ disabledTuiAgents: ['claude'] })

    expect(mocks.apply).toHaveBeenCalledWith(
      true,
      expect.anything(),
      expect.objectContaining({ keepSharedEntries: true })
    )
  })
})
