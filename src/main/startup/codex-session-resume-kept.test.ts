import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedCodexResumeSource } from '../codex/codex-session-resume-preparation'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'

const mocks = vi.hoisted(() => ({
  systemHomePath: '',
  sharedHomePath: '',
  prepareCodexSessionResume: vi.fn(),
  resolveSelected: vi.fn((): string | null => null),
  resolveKept: vi.fn((_accountId: string): string => '')
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/orca-user-data') } }))
vi.mock('../codex/hook-service', () => ({
  codexHookService: {
    installForLaunchPrep: vi.fn(async () => {}),
    refreshRuntimeUserHooksForLaunchPrep: vi.fn(async () => {})
  }
}))
vi.mock('../codex/codex-hook-reconcile', () => ({
  reconcileCodexHooksForLaunch: vi.fn(async () => {})
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabledForAgent: () => false
}))
vi.mock('../codex/codex-home-paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSystemCodexHomePath: () => mocks.systemHomePath,
  getOrcaManagedCodexHomePath: () => mocks.sharedHomePath
}))
vi.mock('../codex/codex-session-resume-preparation', () => ({
  prepareCodexSessionResume: mocks.prepareCodexSessionResume
}))
vi.mock('../codex/codex-legacy-session-resume', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareLegacySharedCodexSessionResume: vi.fn(async () => ({ useRealCodexHome: false }))
}))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    codexRuntimeHome: {
      isHostSystemDefaultRealHomeSelected: () => false,
      getHostCodexHomePathsForSessionDiscovery: () => [],
      resolveSelectedHostAccountCodexHomePathForResume: mocks.resolveSelected,
      resolveHostAccountCodexHomePathForKeptResume: mocks.resolveKept
    },
    store: {
      getSettings: () => ({
        codexManagedAccounts: [{ id: 'account-a', email: 'a@example.com' }]
      })
    }
  }
}))

import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'

const ROLLOUT = join('sessions', '2026', '10', '14', 'rollout-2026-10-14T10-00-00-abc.jsonl')

describe('resuming a kept Codex conversation', () => {
  let root: string
  let keptHome: string
  let selectedHome: string
  let rankedHome: string | null | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'orca-kept-resume-'))
    // Why: the move writes its audit record under userData, which must be a temp folder here.
    vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
    keptHome = join(root, 'codex-accounts', 'account-a', 'home')
    selectedHome = join(root, 'codex-accounts', 'account-b', 'home')
    mocks.systemHomePath = join(root, 'system', '.codex')
    mocks.sharedHomePath = join(root, 'codex-runtime-home', 'home')
    for (const home of [keptHome, selectedHome, mocks.systemHomePath, mocks.sharedHomePath]) {
      mkdirSync(home, { recursive: true })
    }
    // The rollout lives in the selected account's home; the conversation is kept on A.
    mkdirSync(dirname(join(selectedHome, ROLLOUT)), { recursive: true })
    writeFileSync(join(selectedHome, ROLLOUT), '{"type":"session_meta"}\n')
    mocks.resolveSelected.mockReturnValue(selectedHome)
    mocks.resolveKept.mockReturnValue(keptHome)
    rankedHome = undefined
    mocks.prepareCodexSessionResume.mockImplementation(
      async (args: {
        getSelectedAccountCodexHome: () => string | null
        resolveVerifiedResumeHome: (source: VerifiedCodexResumeSource) => Promise<string>
      }) => {
        rankedHome = args.getSelectedAccountCodexHome()
        return {
          outcome: 'resume' as const,
          codexHomePath: await args.resolveVerifiedResumeHome({
            homePath: selectedHome,
            transcriptPath: join(selectedHome, ROLLOUT)
          })
        }
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  function resume(
    keptAccount: { accountId: string | null },
    launchEnv?: NodeJS.ProcessEnv
  ): ReturnType<typeof prepareCodexSessionResumeForLaunch> {
    return prepareCodexSessionResumeForLaunch({
      providerSession: { key: 'session_id', id: 'abc' },
      target: { runtime: 'host' },
      keptAccount,
      ...(launchEnv ? { launchEnv } : {})
    })
  }

  it('moves the conversation into the kept home and never consults the selection', async () => {
    await expect(resume({ accountId: 'account-a' })).resolves.toMatchObject({
      outcome: 'resume',
      codexHomePath: keptHome
    })
    expect(existsSync(join(keptHome, ROLLOUT))).toBe(true)
    expect(mocks.resolveKept).toHaveBeenCalledWith('account-a')
    expect(mocks.resolveSelected).not.toHaveBeenCalled()
    expect(rankedHome).toBe(keptHome)
  })

  it('resumes a conversation kept on System default in the system home', async () => {
    await expect(resume({ accountId: null })).resolves.toMatchObject({
      codexHomePath: mocks.systemHomePath
    })
    expect(mocks.resolveKept).not.toHaveBeenCalled()
  })

  it('refuses System default while a custom CODEX_HOME is set, never using the mirror', async () => {
    await expect(resume({ accountId: null }, { CODEX_HOME: join(root, 'custom') })).rejects.toThrow(
      /CODEX_HOME is set/
    )
    expect(mocks.prepareCodexSessionResume).not.toHaveBeenCalled()
  })

  it('refuses while the kept home is unreadable instead of falling back', async () => {
    mocks.resolveKept.mockImplementation(() => {
      throw new ManagedCodexHomeTemporarilyUnavailableError()
    })
    await expect(resume({ accountId: 'account-a' })).rejects.toBeInstanceOf(
      ManagedCodexHomeTemporarilyUnavailableError
    )
    expect(mocks.prepareCodexSessionResume).not.toHaveBeenCalled()
  })

  it('refuses a kept conversation whose transcript was not found', async () => {
    mocks.prepareCodexSessionResume.mockResolvedValue({
      outcome: 'fresh',
      claimedCodexProvenance: true
    })
    await expect(resume({ accountId: 'account-a' })).rejects.toThrow(
      /kept on a@example\.com, but its conversation was not found/
    )
  })
})
