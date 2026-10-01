import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { VerifiedCodexResumeSource } from '../codex/codex-session-resume-preparation'

/**
 * Turning Codex off in the per-agent hook settings removes Orca's Codex hook
 * entry. Launch prep and session resume must read that same opt-out, or the
 * next Codex launch writes the entry straight back.
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
    installForLaunchPrep: vi.fn(async () => {}),
    refreshRuntimeUserHooksForLaunchPrep: vi.fn(async () => {}),
    ensureRealHomeCodexHookState: vi.fn(async () => 'installed' as const),
    awaitRealHomeCodexHookTrust: vi.fn(async () => 'installed' as const),
    prepareCodexSessionResume: vi.fn()
  }
})

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/orca-user-data') } }))
vi.mock('../agent-trust-presets', () => ({ markCodexProjectTrusted: vi.fn(async () => {}) }))
vi.mock('../codex/hook-service', () => ({
  codexHookService: {
    prepareRuntimeHomeForLaunch: mocks.prepareRuntimeHomeForLaunch,
    installForLaunchPrep: mocks.installForLaunchPrep,
    refreshRuntimeUserHooksForLaunchPrep: mocks.refreshRuntimeUserHooksForLaunchPrep
  }
}))
vi.mock('../codex/codex-real-home-hook-install', () => ({
  awaitRealHomeCodexHookTrust: mocks.awaitRealHomeCodexHookTrust,
  ensureRealHomeCodexHookState: mocks.ensureRealHomeCodexHookState
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
    async ({ settings, codexHooksOn }) => {
      mocks.settings = settings
      mocks.isHostSystemDefaultRealHomeSelected.mockReturnValue(true)

      await expect(prepareCodexRuntimeHomeForLaunch()).resolves.toBeNull()

      expect(mocks.ensureRealHomeCodexHookState).toHaveBeenCalledTimes(1)
      expect(mocks.ensureRealHomeCodexHookState).toHaveBeenCalledWith(
        expect.objectContaining({ hooksEnabled: codexHooksOn, writePolicy: 'add-missing-only' })
      )
      expect(mocks.prepareRuntimeHomeForLaunch).not.toHaveBeenCalled()
    }
  )

  it.each(HOOK_SETTINGS)(
    'managed account home launch with $name: hooks on = $codexHooksOn',
    async ({ settings, codexHooksOn }) => {
      mocks.settings = settings
      mocks.prepareForCodexLaunchAsync.mockResolvedValue(ACCOUNT_HOME)

      await expect(prepareCodexRuntimeHomeForLaunch()).resolves.toBe(ACCOUNT_HOME)

      expect(mocks.ensureRealHomeCodexHookState).not.toHaveBeenCalled()
      expect(mocks.prepareRuntimeHomeForLaunch).toHaveBeenCalledWith(
        ACCOUNT_HOME,
        undefined,
        codexHooksOn
      )
    }
  )

  it.each(HOOK_SETTINGS)(
    'resume into the real ~/.codex with $name: hooks on = $codexHooksOn',
    async ({ settings, codexHooksOn }) => {
      mocks.settings = settings

      await resumeFrom(SYSTEM_HOME)

      expect(mocks.ensureRealHomeCodexHookState).toHaveBeenCalledTimes(1)
      expect(mocks.ensureRealHomeCodexHookState).toHaveBeenCalledWith(
        expect.objectContaining({ hooksEnabled: codexHooksOn, writePolicy: 'add-missing-only' })
      )
      // Why: a resume has no managed home to fall back to, so it waits on a running approval.
      expect(mocks.awaitRealHomeCodexHookTrust).toHaveBeenCalledOnce()
      expect(mocks.installForLaunchPrep).not.toHaveBeenCalled()
      expect(mocks.refreshRuntimeUserHooksForLaunchPrep).not.toHaveBeenCalled()
    }
  )

  it.each(HOOK_SETTINGS)(
    'resume into a managed account home with $name: hooks on = $codexHooksOn',
    async ({ settings, codexHooksOn }) => {
      mocks.settings = settings

      await resumeFrom(ACCOUNT_HOME)

      expect(mocks.ensureRealHomeCodexHookState).not.toHaveBeenCalled()
      expect(mocks.awaitRealHomeCodexHookTrust).not.toHaveBeenCalled()
      if (codexHooksOn) {
        expect(mocks.installForLaunchPrep).toHaveBeenCalledWith(ACCOUNT_HOME)
        expect(mocks.refreshRuntimeUserHooksForLaunchPrep).not.toHaveBeenCalled()
      } else {
        expect(mocks.installForLaunchPrep).not.toHaveBeenCalled()
        expect(mocks.refreshRuntimeUserHooksForLaunchPrep).toHaveBeenCalledWith(ACCOUNT_HOME)
      }
    }
  )
})
