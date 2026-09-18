import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'

// Why the mocks: this file proves only the hooks-off gate in front of the resume hook repair;
// the real import graph reaches electron, rollout discovery on disk, and the codex grant client.
// `managed-agent-hook-controls` is deliberately NOT mocked so the gate reads the real predicate.
const {
  ensureRealHomeCodexHookState,
  installForLaunchPrep,
  refreshRuntimeUserHooksForLaunchPrep,
  resumeHomePath
} = vi.hoisted(() => ({
  ensureRealHomeCodexHookState: vi.fn(() => Promise.resolve('installed')),
  installForLaunchPrep: vi.fn(() => Promise.resolve({ state: 'installed' })),
  refreshRuntimeUserHooksForLaunchPrep: vi.fn(() => Promise.resolve({ state: 'installed' })),
  resumeHomePath: { current: '/home/user/.codex' }
}))
vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))
vi.mock('../codex/codex-real-home-hook-install', () => ({ ensureRealHomeCodexHookState }))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { installForLaunchPrep, refreshRuntimeUserHooksForLaunchPrep }
}))
vi.mock('../agent-trust-presets', () => ({ markCodexProjectTrusted: vi.fn() }))
vi.mock('../codex/codex-legacy-session-resume', () => ({
  prepareLegacySharedCodexSessionResume: () => Promise.resolve({ useRealCodexHome: false })
}))
vi.mock('../codex/codex-home-paths', () => ({
  getSystemCodexHomePath: () => '/home/user/.codex',
  getOrcaManagedCodexHomePath: () => '/user-data/codex-home'
}))
vi.mock('../codex/codex-session-resume-preparation', () => ({
  prepareCodexSessionResume: async (args: {
    resolveVerifiedResumeHome: (source: {
      transcriptPath: string
      homePath: string
    }) => Promise<string>
  }) => ({
    outcome: 'resume' as const,
    codexHomePath: await args.resolveVerifiedResumeHome({
      transcriptPath: '/rollout.jsonl',
      homePath: resumeHomePath.current
    })
  })
}))

import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'
import { mainProcessState } from './main-process-state'

const PROVIDER_SESSION = {
  id: 'session-1',
  transcriptPath: '/rollout.jsonl'
} as unknown as AgentProviderSessionMetadata

function setUpResume(agentStatusHooksEnabled: boolean | undefined, homePath: string): void {
  resumeHomePath.current = homePath
  mainProcessState.store = {
    getSettings: () => ({ agentStatusHooksEnabled })
  } as unknown as typeof mainProcessState.store
  mainProcessState.codexRuntimeHome = {
    getHostCodexHomePathsForSessionDiscovery: () => [],
    resolveSelectedHostAccountCodexHomePathForResume: () => null,
    isHostSystemDefaultRealHome: () => true
  } as unknown as typeof mainProcessState.codexRuntimeHome
}

function launch(): ReturnType<typeof prepareCodexSessionResumeForLaunch> {
  return prepareCodexSessionResumeForLaunch({
    providerSession: PROVIDER_SESSION,
    target: { runtime: 'host' },
    workspacePath: '/repo/wt'
  })
}

beforeEach(() => {
  ensureRealHomeCodexHookState.mockClear()
  installForLaunchPrep.mockClear()
  refreshRuntimeUserHooksForLaunchPrep.mockClear()
})

describe('prepareCodexSessionResumeForLaunch hook repair', () => {
  it('never touches the user-global ~/.codex when this profile has status hooks off', async () => {
    setUpResume(false, '/home/user/.codex')

    await expect(launch()).resolves.toMatchObject({ codexHomePath: '/home/user/.codex' })

    expect(ensureRealHomeCodexHookState).not.toHaveBeenCalled()
  })

  it('skips the legacy runtime-user refresh, which sweeps ~/.codex too, when hooks are off', async () => {
    setUpResume(false, '/user-data/codex-home')

    await expect(launch()).resolves.toMatchObject({ codexHomePath: '/user-data/codex-home' })

    expect(refreshRuntimeUserHooksForLaunchPrep).not.toHaveBeenCalled()
    expect(installForLaunchPrep).not.toHaveBeenCalled()
  })

  it('installs into the real home when status hooks are on', async () => {
    setUpResume(true, '/home/user/.codex')

    await launch()

    expect(ensureRealHomeCodexHookState).toHaveBeenCalledTimes(1)
    expect(ensureRealHomeCodexHookState).toHaveBeenCalledWith({
      hooksEnabled: true,
      userDataPath: '/user-data'
    })
  })

  it('installs into a managed resume home when status hooks are on', async () => {
    setUpResume(undefined, '/user-data/codex-home')

    await launch()

    expect(installForLaunchPrep).toHaveBeenCalledWith('/user-data/codex-home')
    expect(ensureRealHomeCodexHookState).not.toHaveBeenCalled()
  })
})
