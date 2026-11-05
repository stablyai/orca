import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../../../codex-accounts/host-codex-managed-home-ownership'
import { prepareCodexAiVaultSessionResume } from './codex-ai-vault-session-resume'
import { getOrcaManagedCodexHomePath } from '../../configuration/homes/codex-home-paths'

const ROLLOUT_RELATIVE_PATH = join(
  'sessions',
  '2026',
  '08',
  '17',
  'rollout-2026-08-17T10-00-00-session.jsonl'
)

// Why: session backfill resolves Orca's managed Codex home from userData, which otherwise resolves to the live one.
let userDataRoot: string
beforeEach(() => {
  userDataRoot = mkdtempSync(join(tmpdir(), 'orca-codex-resume-user-data-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userDataRoot)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(userDataRoot, { recursive: true, force: true })
})

describe('prepareCodexAiVaultSessionResume', () => {
  let root: string
  let peerHome: string
  let selectedHome: string
  let peerRolloutPath: string
  let preparePinnedLaunchHome: ReturnType<typeof vi.fn<(home: string) => Promise<void>>>

  beforeEach(() => {
    preparePinnedLaunchHome = vi.fn(async () => undefined)
    root = mkdtempSync(join(tmpdir(), 'orca-codex-ai-vault-resume-'))
    peerHome = join(root, 'codex-accounts', 'account-a', 'home')
    selectedHome = join(root, 'codex-accounts', 'account-b', 'home')
    peerRolloutPath = join(peerHome, ROLLOUT_RELATIVE_PATH)
    const selectedRolloutPath = join(selectedHome, ROLLOUT_RELATIVE_PATH)
    mkdirSync(dirname(peerRolloutPath), { recursive: true })
    mkdirSync(dirname(selectedRolloutPath), { recursive: true })
    writeFileSync(peerRolloutPath, '{"type":"session_meta"}\n', 'utf-8')
    linkSync(peerRolloutPath, selectedRolloutPath)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses before falling through when selected-home trust is indeterminate', async () => {
    const resolveSelectedHome = vi.fn((): string | null => {
      throw new ManagedCodexHomeTemporarilyUnavailableError()
    })
    const isSystemDefaultRealHome = vi.fn(() => true)

    await expect(prepare(resolveSelectedHome, isSystemDefaultRealHome)).rejects.toBeInstanceOf(
      ManagedCodexHomeTemporarilyUnavailableError
    )
    expect(resolveSelectedHome).toHaveBeenCalledOnce()
    expect(isSystemDefaultRealHome).not.toHaveBeenCalled()
  })

  it('repins an aliased rollout when the selected home is owned', async () => {
    await expect(prepare(() => selectedHome)).resolves.toEqual({
      useRealCodexHome: false,
      substituteCodexHome: selectedHome
    })
  })

  it('leaves a fork moved into the real home to the pane spawn', async () => {
    const legacyHome = getOrcaManagedCodexHomePath()
    const legacyRolloutPath = join(legacyHome, ROLLOUT_RELATIVE_PATH)
    mkdirSync(dirname(legacyRolloutPath), { recursive: true })
    writeFileSync(legacyRolloutPath, '{"type":"session_meta"}\n', 'utf-8')

    await expect(
      prepareFork({
        codexHome: legacyHome,
        filePath: legacyRolloutPath,
        isSystemDefaultRealHome: () => true,
        discoveryHomes: [legacyHome]
      })
    ).resolves.toEqual({ useRealCodexHome: true })
    expect(preparePinnedLaunchHome).not.toHaveBeenCalled()
  })

  function prepareFork(
    overrides: {
      resolveSelectedHome?: () => string | null
      isSystemDefaultRealHome?: () => boolean
      discoveryHomes?: readonly string[]
      discovery?: () => string[]
      runtimeHome?: null
      executionHostId?: string
      codexHome?: string
      filePath?: string
    } = {}
  ) {
    const runtimeHome =
      overrides.runtimeHome === null
        ? null
        : {
            isHostSystemDefaultRealHomeSelected: overrides.isSystemDefaultRealHome ?? (() => false),
            resolveSelectedHostAccountCodexHomePathForResume:
              overrides.resolveSelectedHome ?? (() => null),
            getHostCodexHomePathsForSessionDiscovery:
              overrides.discovery ??
              (() => [...(overrides.discoveryHomes ?? [peerHome, selectedHome])])
          }
    return prepareCodexAiVaultSessionResume(
      {
        agent: 'codex',
        filePath: overrides.filePath ?? peerRolloutPath,
        codexHome: overrides.codexHome ?? peerHome,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test feeds host ids the RPC may receive; the function only compares them.
        executionHostId: (overrides.executionHostId ?? 'local') as 'local',
        fork: true
      },
      {
        runtimeHome,
        systemCodexHomePath: join(root, 'system-codex-home'),
        preparePinnedLaunchHome
      }
    )
  }

  function prepare(
    resolveSelectedHome: () => string | null,
    isSystemDefaultRealHome: () => boolean = () => false
  ) {
    return prepareCodexAiVaultSessionResume(
      {
        agent: 'codex',
        filePath: peerRolloutPath,
        codexHome: peerHome,
        executionHostId: 'local'
      },
      {
        runtimeHome: {
          isHostSystemDefaultRealHomeSelected: isSystemDefaultRealHome,
          resolveSelectedHostAccountCodexHomePathForResume: resolveSelectedHome,
          getHostCodexHomePathsForSessionDiscovery: () => [peerHome, selectedHome]
        },
        systemCodexHomePath: join(root, 'system-codex-home'),
        preparePinnedLaunchHome
      }
    )
  }
})
