import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { VerifiedCodexResumeSource } from '../codex/codex-session-resume-preparation'

/**
 * Launch prep and session resume must read the per-agent Codex hook opt-out
 * for the managed homes they prepare, and must never write the real ~/.codex:
 * Orca's hook rides each launch as a session flag, whatever the setting.
 */
const SYSTEM_HOME = '/home/user/.codex'
const ACCOUNT_HOME = '/accounts/one/.codex'

const mocks = vi.hoisted(() => {
  const settings: Partial<GlobalSettings> = {}
  return {
    settings,
    prepareForCodexLaunchAsync: vi.fn(async (): Promise<string | null> => null),
    isHostSystemDefaultRealHomeSelected: vi.fn(() => false),
    prepareRuntimeHomeForLaunch: vi.fn(async () => ({ state: 'ok' as const })),
    removeRealHomeCodexHookEntries: vi.fn(async () => 'removed' as const),
    prepareCodexSessionResume: vi.fn()
  }
})

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/orca-user-data') } }))
vi.mock('../agent-trust-presets', () => ({ markCodexProjectTrusted: vi.fn(async () => {}) }))
vi.mock('../codex/hook-service', () => ({
  codexHookService: {
    prepareRuntimeHomeForLaunch: mocks.prepareRuntimeHomeForLaunch
  }
}))
// Why: the only module that writes ~/.codex; launch prep must never reach it.
vi.mock('../codex/codex-real-home-hook-install', () => ({
  removeRealHomeCodexHookEntries: mocks.removeRealHomeCodexHookEntries
}))
// Why: the real predicate, without loading every agent's hook service.
vi.mock(
  '../agent-hooks/managed-agent-hook-controls',
  async () => await import('../../shared/agent-status-hooks-setting')
)
vi.mock('../wsl', () => ({ getDefaultWslDistro: () => 'Ubuntu' }))
vi.mock('../codex/codex-home-paths', () => ({
  getSystemCodexHomePath: () => SYSTEM_HOME,
  getOrcaManagedCodexHomePath: () => '/managed/.codex'
}))
vi.mock('../codex/codex-session-resume-preparation', () => ({
  prepareCodexSessionResume: mocks.prepareCodexSessionResume
}))
vi.mock('../codex/codex-legacy-session-resume', () => ({
  prepareLegacySharedCodexSessionResume: vi.fn(async () => ({ useRealCodexHome: false }))
}))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    codexRuntimeHome: {
      prepareForCodexLaunchAsync: mocks.prepareForCodexLaunchAsync,
      isHostSystemDefaultRealHomeSelected: mocks.isHostSystemDefaultRealHomeSelected,
      isHostSystemDefaultRealHome: () => false,
      getHostCodexHomePathsForSessionDiscovery: () => [],
      resolveSelectedHostAccountCodexHomePathForResume: () => null
    },
    store: { getSettings: () => mocks.settings }
  }
}))

import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'
import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'

const HOOK_SETTINGS: readonly {
  name: string
  settings: Partial<GlobalSettings>
  codexHooksOn: boolean
}[] = [
  {
    name: 'Codex turned off per agent',
    settings: { agentStatusHooksEnabled: true, disabledTuiAgents: ['codex'] },
    codexHooksOn: false
  },
  {
    name: 'every agent on',
    settings: { agentStatusHooksEnabled: true, disabledTuiAgents: [] },
    codexHooksOn: true
  },
  {
    name: 'another agent turned off',
    settings: { agentStatusHooksEnabled: true, disabledTuiAgents: ['claude'] },
    codexHooksOn: true
  },
  {
    name: 'the global switch off',
    settings: { agentStatusHooksEnabled: false, disabledTuiAgents: [] },
    codexHooksOn: false
  }
]

function resumeFrom(homePath: string): Promise<unknown> {
  mocks.prepareCodexSessionResume.mockImplementation(
    async (args: {
      resolveVerifiedResumeHome: (source: VerifiedCodexResumeSource) => Promise<string>
    }) => {
      const codexHomePath = await args.resolveVerifiedResumeHome({
        homePath,
        transcriptPath: `${homePath}/sessions/abc.jsonl`
      })
      return { outcome: 'resume' as const, codexHomePath, sessionId: 'abc' }
    }
  )
  return prepareCodexSessionResumeForLaunch({
    providerSession: { key: 'session_id', id: 'abc' },
    target: { runtime: 'host' }
  })
}

describe('Codex launch prep honours the per-agent hook opt-out', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isHostSystemDefaultRealHomeSelected.mockReturnValue(false)
    mocks.prepareForCodexLaunchAsync.mockResolvedValue(null)
  })

  it.each(HOOK_SETTINGS)(
    'real ~/.codex launch with $name: hooks on = $codexHooksOn',
    async ({ settings }) => {
      mocks.settings = settings
      mocks.isHostSystemDefaultRealHomeSelected.mockReturnValue(true)

      await expect(prepareCodexRuntimeHomeForLaunch()).resolves.toBeNull()

      expect(mocks.removeRealHomeCodexHookEntries).not.toHaveBeenCalled()
      expect(mocks.prepareRuntimeHomeForLaunch).not.toHaveBeenCalled()
    }
  )

  it.each(HOOK_SETTINGS)(
    'managed account home launch with $name: hooks on = $codexHooksOn',
    async ({ settings, codexHooksOn }) => {
      mocks.settings = settings
      mocks.prepareForCodexLaunchAsync.mockResolvedValue(ACCOUNT_HOME)

      await expect(prepareCodexRuntimeHomeForLaunch()).resolves.toBe(ACCOUNT_HOME)

      expect(mocks.removeRealHomeCodexHookEntries).not.toHaveBeenCalled()
      expect(mocks.prepareRuntimeHomeForLaunch).toHaveBeenCalledWith(
        ACCOUNT_HOME,
        undefined,
        codexHooksOn
      )
    }
  )

  it.each(HOOK_SETTINGS)(
    'resume into the real ~/.codex with $name: hooks on = $codexHooksOn',
    async ({ settings }) => {
      mocks.settings = settings

      await expect(resumeFrom(SYSTEM_HOME)).resolves.toMatchObject({
        codexHomePath: SYSTEM_HOME
      })

      expect(mocks.removeRealHomeCodexHookEntries).not.toHaveBeenCalled()
      expect(mocks.prepareRuntimeHomeForLaunch).not.toHaveBeenCalled()
    }
  )

  it.each(HOOK_SETTINGS)(
    'resume into a managed account home with $name: hooks on = $codexHooksOn',
    async ({ settings, codexHooksOn }) => {
      mocks.settings = settings

      await expect(resumeFrom(ACCOUNT_HOME)).resolves.toMatchObject({
        codexHomePath: ACCOUNT_HOME
      })

      expect(mocks.removeRealHomeCodexHookEntries).not.toHaveBeenCalled()
      expect(mocks.prepareRuntimeHomeForLaunch).toHaveBeenCalledOnce()
      expect(mocks.prepareRuntimeHomeForLaunch).toHaveBeenCalledWith(
        ACCOUNT_HOME,
        undefined,
        codexHooksOn
      )
    }
  )
})
