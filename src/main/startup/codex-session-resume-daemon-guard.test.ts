import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedCodexResumeSource } from '../codex/codex-session-resume-preparation'
import {
  CODEX_DAEMON_OVERRIDE_MARKER,
  codexDaemonSocketPathExceedsLimit
} from '../codex/codex-daemon-socket-path-guard'

const mocks = vi.hoisted(() => ({
  hooksEnabled: false,
  systemHomePath: '',
  sharedHomePath: '',
  prepareRuntimeHomeForLaunch: vi.fn(),
  removeRealHomeCodexHookEntries: vi.fn(async () => 'removed' as const),
  prepareCodexSessionResume: vi.fn(),
  prepareLegacySharedCodexSessionResume: vi.fn(),
  syncCodexHookFlagsWithin: vi.fn(async () => {})
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/orca-user-data') } }))
vi.mock('../codex/hook-service', () => ({
  codexHookService: {
    prepareRuntimeHomeForLaunch: mocks.prepareRuntimeHomeForLaunch
  }
}))
// Why: the only module that writes ~/.codex; a resume must never reach it.
vi.mock('../codex/codex-real-home-hook-install', () => ({
  removeRealHomeCodexHookEntries: mocks.removeRealHomeCodexHookEntries
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabledForAgent: () => mocks.hooksEnabled
}))
vi.mock('../codex/codex-home-paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSystemCodexHomePath: () => mocks.systemHomePath,
  getOrcaManagedCodexHomePath: () => mocks.sharedHomePath
}))
vi.mock('../codex/codex-hook-flag-sync', () => ({
  syncCodexHookFlagsWithin: mocks.syncCodexHookFlagsWithin
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
      isHostSystemDefaultRealHome: () => false,
      getHostCodexHomePathsForSessionDiscovery: () => [],
      resolveSelectedHostAccountCodexHomePathForResume: () => null
    },
    store: { getSettings: () => ({}) }
  }
}))

import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'

// Why: long enough that the daemon socket overflows sun_path on every host OS.
const LONG_SEGMENT = 'a'.repeat(60)

describe('Codex session resume daemon socket guard', () => {
  let root: string
  let accountHome: string
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'orca-resume-guard-'))
    accountHome = join(root, 'codex-accounts', LONG_SEGMENT, 'home')
    mocks.systemHomePath = join(root, 'system', LONG_SEGMENT, '.codex')
    mocks.sharedHomePath = join(root, 'codex-runtime-home', 'home')
    for (const home of [accountHome, mocks.systemHomePath, mocks.sharedHomePath]) {
      mkdirSync(home, { recursive: true })
    }
    mocks.hooksEnabled = false
    mocks.prepareLegacySharedCodexSessionResume.mockResolvedValue({ useRealCodexHome: false })
    mocks.prepareCodexSessionResume.mockImplementation(
      async (args: {
        resolveVerifiedResumeHome: (source: VerifiedCodexResumeSource) => Promise<string>
      }) => ({
        outcome: 'resume' as const,
        codexHomePath: await args.resolveVerifiedResumeHome({
          homePath: accountHome,
          transcriptPath: join(accountHome, 'sessions', 'abc.jsonl')
        })
      })
    )
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  function resume(): ReturnType<typeof prepareCodexSessionResumeForLaunch> {
    return prepareCodexSessionResumeForLaunch({
      providerSession: { key: 'session_id', id: 'abc' },
      target: { runtime: 'host' }
    })
  }

  it('guards the resumed account home when hook repair fails before mirroring config', async () => {
    expect(codexDaemonSocketPathExceedsLimit(accountHome)).toBe(true)
    writeFileSync(join(accountHome, 'config.toml'), 'model = "gpt-5"\n', 'utf-8')
    mocks.hooksEnabled = true
    mocks.prepareRuntimeHomeForLaunch.mockRejectedValue(
      new Error('Could not parse Codex hooks.json')
    )

    const preparation = await resume()

    expect(preparation).toMatchObject({ outcome: 'resume', codexHomePath: accountHome })
    expect(mocks.prepareRuntimeHomeForLaunch).toHaveBeenCalledWith(accountHome, undefined, true)
    const config = readFileSync(join(accountHome, 'config.toml'), 'utf-8')
    expect(config).toContain('model = "gpt-5"')
    expect(config).toContain(`daemon_auto_start = false ${CODEX_DAEMON_OVERRIDE_MARKER}`)
  })

  it('guards the resumed account home when hooks are off and the refresh returns early', async () => {
    mocks.prepareRuntimeHomeForLaunch.mockResolvedValue({
      agent: 'codex',
      state: 'error',
      detail: 'Could not read system Codex hooks.json'
    })

    await resume()

    expect(mocks.prepareRuntimeHomeForLaunch).toHaveBeenCalledWith(accountHome, undefined, false)
    expect(readFileSync(join(accountHome, 'config.toml'), 'utf-8')).toContain(
      `daemon_auto_start = false ${CODEX_DAEMON_OVERRIDE_MARKER}`
    )
  })

  it('never writes the guard into the real Codex home a migrated resume runs in', async () => {
    expect(codexDaemonSocketPathExceedsLimit(mocks.systemHomePath)).toBe(true)
    mocks.prepareLegacySharedCodexSessionResume.mockResolvedValue({ useRealCodexHome: true })

    const preparation = await resume()

    expect(preparation).toMatchObject({ codexHomePath: mocks.systemHomePath })
    expect(mocks.prepareRuntimeHomeForLaunch).not.toHaveBeenCalled()
    expect(mocks.removeRealHomeCodexHookEntries).not.toHaveBeenCalled()
    expect(readdirSync(mocks.systemHomePath)).toEqual([])
  })

  // Why: at a cold restore the resume can beat the start's derivation of the flag it needs.
  it('syncs the flags, waiting at most 3 s, before resuming while hooks are on', async () => {
    mocks.hooksEnabled = true
    mocks.prepareRuntimeHomeForLaunch.mockResolvedValue({ agent: 'codex', state: 'installed' })
    let settle!: () => void
    mocks.syncCodexHookFlagsWithin.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    let resumed = false
    const pending = resume().then(() => {
      resumed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(resumed).toBe(false)

    settle()
    await pending

    expect(mocks.syncCodexHookFlagsWithin).toHaveBeenCalledWith(3_000)
  })

  it('does not wait for a flag while Codex hooks are off', async () => {
    mocks.prepareRuntimeHomeForLaunch.mockResolvedValue({ agent: 'codex', state: 'installed' })

    await resume()

    expect(mocks.syncCodexHookFlagsWithin).not.toHaveBeenCalled()
  })
})
