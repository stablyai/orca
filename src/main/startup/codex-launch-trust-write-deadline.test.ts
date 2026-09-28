import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedCodexResumeSource } from '../codex/codex-session-resume-preparation'

/**
 * Why this file exists: both Codex launch-prep entry points await the trust
 * write, and the PTY spawn awaits them, so an unbounded write turns a stuck
 * per-`config.toml` lane into a launch that never starts. These cases pin the
 * bound and the fail-closed consequence: giving up writes nothing, so the
 * workspace stays untrusted and Codex raises its own trust menu.
 */
const mocks = vi.hoisted(() => ({
  markCodexProjectTrusted: vi.fn(),
  prepareForCodexLaunchAsync: vi.fn(),
  isHostSystemDefaultRealHomeSelected: vi.fn(() => false),
  isHostSystemDefaultRealHome: vi.fn(() => false),
  getHostCodexHomePathsForSessionDiscovery: vi.fn((): string[] => []),
  resolveSelectedHostAccountCodexHomePathForResume: vi.fn(() => null),
  prepareRuntimeHomeForLaunch: vi.fn(async () => ({ state: 'ok' as const })),
  installForLaunchPrep: vi.fn(async () => {}),
  refreshRuntimeUserHooksForLaunchPrep: vi.fn(async () => {}),
  ensureRealHomeCodexHookState: vi.fn(async () => {}),
  prepareCodexSessionResume: vi.fn(),
  prepareLegacySharedCodexSessionResume: vi.fn(async () => ({ useRealCodexHome: false }))
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/orca-user-data') } }))
vi.mock('../agent-trust-presets', () => ({
  markCodexProjectTrusted: mocks.markCodexProjectTrusted
}))
vi.mock('../codex/hook-service', () => ({
  codexHookService: {
    prepareRuntimeHomeForLaunch: mocks.prepareRuntimeHomeForLaunch,
    installForLaunchPrep: mocks.installForLaunchPrep,
    refreshRuntimeUserHooksForLaunchPrep: mocks.refreshRuntimeUserHooksForLaunchPrep
  }
}))
vi.mock('../codex/codex-real-home-hook-install', () => ({
  ensureRealHomeCodexHookState: mocks.ensureRealHomeCodexHookState
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabled: () => false
}))
vi.mock('../wsl', () => ({ getDefaultWslDistro: () => 'Ubuntu' }))
vi.mock('../codex/codex-home-paths', () => ({
  getSystemCodexHomePath: () => '/home/user/.codex',
  getOrcaManagedCodexHomePath: () => '/managed/.codex'
}))
vi.mock('../codex/codex-session-resume-preparation', () => ({
  prepareCodexSessionResume: mocks.prepareCodexSessionResume
}))
vi.mock('../codex/codex-legacy-session-resume', () => ({
  prepareLegacySharedCodexSessionResume: mocks.prepareLegacySharedCodexSessionResume
}))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    codexRuntimeHome: {
      prepareForCodexLaunchAsync: mocks.prepareForCodexLaunchAsync,
      isHostSystemDefaultRealHomeSelected: mocks.isHostSystemDefaultRealHomeSelected,
      isHostSystemDefaultRealHome: mocks.isHostSystemDefaultRealHome,
      getHostCodexHomePathsForSessionDiscovery: mocks.getHostCodexHomePathsForSessionDiscovery,
      resolveSelectedHostAccountCodexHomePathForResume:
        mocks.resolveSelectedHostAccountCodexHomePathForResume
    },
    store: { getSettings: () => ({}) }
  }
}))

import { AGENT_TRUST_WRITE_DEADLINE_MS } from '../agent-trust-write-deadline'
import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'
import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'

const WORKSPACE = '/workspace/app'
const RESUME_HOME = '/accounts/one/.codex'

function neverSettlingWrite(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('Codex launch-prep trust writes', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isHostSystemDefaultRealHomeSelected.mockReturnValue(false)
    mocks.getHostCodexHomePathsForSessionDiscovery.mockReturnValue([])
    mocks.resolveSelectedHostAccountCodexHomePathForResume.mockReturnValue(null)
    mocks.prepareForCodexLaunchAsync.mockResolvedValue(RESUME_HOME)
    mocks.prepareRuntimeHomeForLaunch.mockResolvedValue({ state: 'ok' as const })
    mocks.prepareLegacySharedCodexSessionResume.mockResolvedValue({ useRealCodexHome: false })
    mocks.prepareCodexSessionResume.mockImplementation(
      async (args: {
        resolveVerifiedResumeHome: (source: VerifiedCodexResumeSource) => Promise<string>
      }) => {
        const codexHomePath = await args.resolveVerifiedResumeHome({
          homePath: RESUME_HOME,
          transcriptPath: `${RESUME_HOME}/sessions/abc.jsonl`
        })
        return { outcome: 'resume' as const, codexHomePath, sessionId: 'abc' }
      }
    )
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('bounds a never-settling write in quick-launch prep and still returns the launch home', async () => {
    vi.useFakeTimers()
    const write = neverSettlingWrite()
    mocks.markCodexProjectTrusted.mockReturnValue(write.promise)
    let settled = false
    const prep = prepareCodexRuntimeHomeForLaunch(
      undefined,
      {},
      {
        launchAgent: 'codex',
        workspacePath: WORKSPACE
      }
    ).then((home) => {
      settled = true
      return home
    })

    await vi.advanceTimersByTimeAsync(AGENT_TRUST_WRITE_DEADLINE_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await expect(prep).resolves.toBe(RESUME_HOME)
    expect(settled).toBe(true)
    expect(String(warn.mock.calls[0]?.[0])).toContain('did not settle')
    expect(vi.getTimerCount()).toBe(0)
    // Fails closed: one abandoned write, no retry and no second trust path, so
    // nothing in this prep can report the workspace as trusted.
    expect(mocks.markCodexProjectTrusted).toHaveBeenCalledTimes(1)
    expect(mocks.markCodexProjectTrusted).toHaveBeenCalledWith(WORKSPACE)
    write.release()
  })

  it('keeps the quick-launch trust write ahead of the home the spawn waits on', async () => {
    mocks.markCodexProjectTrusted.mockResolvedValue(undefined)
    await prepareCodexRuntimeHomeForLaunch(
      undefined,
      {},
      {
        launchAgent: 'codex',
        workspacePath: WORKSPACE
      }
    )
    expect(mocks.markCodexProjectTrusted.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepareForCodexLaunchAsync.mock.invocationCallOrder[0] ?? Infinity
    )
  })

  it('bounds a never-settling write in resume prep and still resolves the resume home', async () => {
    vi.useFakeTimers()
    const write = neverSettlingWrite()
    mocks.markCodexProjectTrusted.mockReturnValue(write.promise)
    let settled = false
    const prep = prepareCodexSessionResumeForLaunch({
      providerSession: { key: 'session_id', id: 'abc' },
      target: { runtime: 'host' },
      workspacePath: WORKSPACE
    }).then((preparation) => {
      settled = true
      return preparation
    })

    await vi.advanceTimersByTimeAsync(AGENT_TRUST_WRITE_DEADLINE_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    const preparation = await prep
    expect(preparation?.outcome).toBe('resume')
    expect(String(warn.mock.calls[0]?.[0])).toContain('did not settle')
    expect(vi.getTimerCount()).toBe(0)
    expect(mocks.markCodexProjectTrusted).toHaveBeenCalledTimes(1)
    expect(mocks.markCodexProjectTrusted).toHaveBeenCalledWith(WORKSPACE)
    write.release()
  })

  it('keeps the resume trust write ahead of the hook repair that precedes the spawn', async () => {
    mocks.markCodexProjectTrusted.mockResolvedValue(undefined)
    await prepareCodexSessionResumeForLaunch({
      providerSession: { key: 'session_id', id: 'abc' },
      target: { runtime: 'host' },
      workspacePath: WORKSPACE
    })
    expect(mocks.markCodexProjectTrusted.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.refreshRuntimeUserHooksForLaunchPrep.mock.invocationCallOrder[0] ?? Infinity
    )
  })

  it('contains a rejected resume trust write without trusting the workspace elsewhere', async () => {
    mocks.markCodexProjectTrusted.mockRejectedValue(new Error('mock EACCES'))
    const preparation = await prepareCodexSessionResumeForLaunch({
      providerSession: { key: 'session_id', id: 'abc' },
      target: { runtime: 'host' },
      workspacePath: WORKSPACE
    })
    expect(preparation?.outcome).toBe('resume')
    expect(mocks.markCodexProjectTrusted).toHaveBeenCalledTimes(1)
  })
})
