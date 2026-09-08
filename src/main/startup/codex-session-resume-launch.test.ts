import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  selected: vi.fn(),
  system: vi.fn(),
  link: vi.fn(),
  transfer: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => '/orca' } }))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    store: { getSettings: () => ({}) },
    codexRuntimeHome: {
      resolveSelectedHostAccountCodexHomePathForResume: mocks.selected,
      isHostSystemDefaultRealHome: mocks.system,
      getHostCodexHomePathsForSessionDiscovery: () => ['/origin']
    }
  }
}))
vi.mock('../codex/codex-session-resume-preparation', () => ({
  prepareCodexSessionResume: async (args: {
    resolveVerifiedResumeHome: (source: unknown) => Promise<string>
  }) => ({
    outcome: 'resume',
    codexHomePath: await args.resolveVerifiedResumeHome({
      homePath: '/origin',
      transcriptPath: '/origin/sessions/thread.jsonl'
    })
  })
}))
vi.mock('../codex/codex-legacy-session-resume', () => ({
  prepareLegacySharedCodexSessionResume: async () => ({ useRealCodexHome: false })
}))
vi.mock('../codex/codex-account-session-bridge', () => ({
  linkCodexRolloutIntoAccountHome: mocks.link
}))
vi.mock('../codex/codex-thread-goal-transfer', () => ({
  transferCodexThreadGoalBetweenHomes: mocks.transfer
}))
vi.mock('../codex/codex-home-paths', () => ({
  getSystemCodexHomePath: () => '/system',
  getOrcaManagedCodexHomePath: () => '/shared'
}))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { refreshRuntimeUserHooksForLaunchPrep: vi.fn() }
}))
vi.mock('../codex/codex-real-home-hook-install', () => ({ ensureRealHomeCodexHookState: vi.fn() }))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabled: () => false
}))
vi.mock('../agent-trust-presets', () => ({ markCodexProjectTrusted: vi.fn() }))

const { prepareCodexSessionResumeForLaunch } = await import('./codex-session-resume-launch')
const launch = () =>
  prepareCodexSessionResumeForLaunch({
    providerSession: {
      key: 'session_id',
      id: 'thread',
      transcriptPath: '/origin/sessions/thread.jsonl'
    },
    target: { runtime: 'host' },
    accountSwitchRestart: true
  })

beforeEach(() => {
  mocks.selected.mockReturnValue(null)
  mocks.system.mockReturnValue(true)
  mocks.link.mockReturnValue('/system/sessions/thread.jsonl')
  mocks.transfer.mockResolvedValue('no-goal')
})

describe('account-switch launch preparation', () => {
  it('resumes in the real home when system default is selected', async () => {
    await expect(launch()).resolves.toMatchObject({ outcome: 'resume', codexHomePath: '/system' })
    expect(mocks.link).toHaveBeenCalledWith(
      expect.objectContaining({ targetCodexHomePath: '/system' })
    )
  })
  it('refuses an unsafe bridge instead of silently creating a fresh conversation', async () => {
    mocks.link.mockReturnValue(null)
    await expect(launch()).rejects.toThrow('Cannot safely resume')
  })
  it('surfaces failed goal transfer', async () => {
    mocks.transfer.mockResolvedValue('failed')
    await expect(launch()).rejects.toThrow('Could not transfer')
  })
})
