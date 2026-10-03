import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'

/**
 * Every Orca on a Windows machine, and Codex run outside Orca, read the WSL
 * guest's own ~/.codex. A profile with status hooks off opening any WSL pane
 * must not strip the Orca entry the other profiles' Codex status depends on.
 */
const GUEST_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
const ACCOUNT_HOME =
  '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-accounts\\one\\home'
const WSL_TARGET = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

const mocks = vi.hoisted(() => {
  const settings: Partial<GlobalSettings> = {}
  return {
    settings,
    prepareForCodexLaunchAsync: vi.fn(async (): Promise<string | null> => null),
    isProfileOwnedWslCodexHome: vi.fn((homePath: string) => homePath === ACCOUNT_HOME),
    prepareRuntimeHomeForLaunch: vi.fn(async () => null),
    ensureRealHomeCodexHookState: vi.fn(async () => 'removed' as const)
  }
})

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/orca-user-data') } }))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: mocks.prepareRuntimeHomeForLaunch }
}))
vi.mock('../codex/codex-real-home-hook-install', () => ({
  ensureRealHomeCodexHookState: mocks.ensureRealHomeCodexHookState
}))
// Why: the real predicate, without loading every agent's hook service.
vi.mock(
  '../agent-hooks/managed-agent-hook-controls',
  async () => await import('../../shared/agent-status-hooks-setting')
)
vi.mock('../wsl', () => ({ getDefaultWslDistro: () => 'Ubuntu' }))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    codexRuntimeHome: {
      prepareForCodexLaunchAsync: mocks.prepareForCodexLaunchAsync,
      isHostSystemDefaultRealHomeSelected: () => false,
      isProfileOwnedWslCodexHome: mocks.isProfileOwnedWslCodexHome
    },
    store: { getSettings: () => mocks.settings }
  }
}))

import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'

const HOOKS_OFF: Partial<GlobalSettings> = { agentStatusHooksEnabled: false }
const HOOKS_ON: Partial<GlobalSettings> = { agentStatusHooksEnabled: true, disabledTuiAgents: [] }

describe('WSL Codex launch prep and the shared guest ~/.codex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    { name: 'status hooks off', settings: HOOKS_OFF },
    {
      name: 'Codex turned off per agent',
      settings: { agentStatusHooksEnabled: true, disabledTuiAgents: ['codex' as const] }
    }
  ])("hands the guest's own ~/.codex over as shared with $name", async ({ settings }) => {
    mocks.settings = settings
    mocks.prepareForCodexLaunchAsync.mockResolvedValue(GUEST_HOME)

    await expect(prepareCodexRuntimeHomeForLaunch(WSL_TARGET)).resolves.toBe(GUEST_HOME)

    expect(mocks.isProfileOwnedWslCodexHome).toHaveBeenCalledWith(GUEST_HOME)
    expect(mocks.prepareRuntimeHomeForLaunch).toHaveBeenCalledExactlyOnceWith(
      GUEST_HOME,
      WSL_TARGET,
      false,
      'shared'
    )
  })

  it("restores the entry in the guest's own ~/.codex on a hooks-on launch", async () => {
    mocks.settings = HOOKS_ON
    mocks.prepareForCodexLaunchAsync.mockResolvedValue(GUEST_HOME)

    await prepareCodexRuntimeHomeForLaunch(WSL_TARGET)

    expect(mocks.prepareRuntimeHomeForLaunch).toHaveBeenCalledWith(
      GUEST_HOME,
      WSL_TARGET,
      true,
      'shared'
    )
  })

  it.each([
    { name: 'hooks off', settings: HOOKS_OFF, hooksEnabled: false },
    { name: 'hooks on', settings: HOOKS_ON, hooksEnabled: true }
  ])(
    "keeps this profile's own WSL account home in step with $name",
    async ({ settings, hooksEnabled }) => {
      mocks.settings = settings
      mocks.prepareForCodexLaunchAsync.mockResolvedValue(ACCOUNT_HOME)

      await prepareCodexRuntimeHomeForLaunch(WSL_TARGET)

      expect(mocks.prepareRuntimeHomeForLaunch).toHaveBeenCalledWith(
        ACCOUNT_HOME,
        WSL_TARGET,
        hooksEnabled,
        'profile'
      )
    }
  )
})
