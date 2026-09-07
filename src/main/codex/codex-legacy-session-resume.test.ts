import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type * as NodeFsPromises from 'node:fs/promises'
import {
  codexRolloutHardlinkIdentity,
  dedupeCodexRolloutFileAliases
} from '../ai-vault/codex-session-root-dedup'
import { prepareLegacySharedCodexSessionResume } from './codex-legacy-session-resume'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'

const lstatFaults = vi.hoisted(() => ({
  path: null as string | null,
  reset(): void {
    lstatFaults.path = null
  }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (args[0] === lstatFaults.path) {
        const error: NodeJS.ErrnoException = new Error(`EBUSY: locked '${args[0]}'`)
        error.code = 'EBUSY'
        throw error
      }
      return actual.lstat(...args)
    }
  }
})

describe('prepareLegacySharedCodexSessionResume', () => {
  let root: string
  let legacyHome: string
  let systemHome: string
  let rolloutPath: string

  beforeEach(() => {
    lstatFaults.reset()
    root = mkdtempSync(join(tmpdir(), 'orca-legacy-codex-resume-'))
    legacyHome = join(root, 'codex-runtime-home', 'home')
    systemHome = join(root, 'real-codex-home')
    rolloutPath = join(
      legacyHome,
      'sessions',
      '2026',
      '07',
      '20',
      'rollout-2026-07-20T12-00-00-session.jsonl'
    )
    mkdirSync(join(rolloutPath, '..'), { recursive: true })
    writeFileSync(rolloutPath, '{"type":"session_meta"}\n', 'utf-8')
  })

  afterEach(() => {
    lstatFaults.reset()
    rmSync(root, { recursive: true, force: true })
  })

  it('materializes an immediate legacy resume into the real home', async () => {
    const result = await prepare()
    const targetPath = targetRolloutPath()

    expect(result).toEqual({ useRealCodexHome: true })
    expect(readFileSync(targetPath, 'utf-8')).toBe('{"type":"session_meta"}\n')
    expect(statSync(targetPath).ino).toBe(statSync(rolloutPath).ino)
  })

  it('materializes a compressed legacy rollout without changing its representation', async () => {
    const compressedPath = `${rolloutPath}.zst`
    rmSync(rolloutPath)
    rolloutPath = compressedPath
    writeFileSync(rolloutPath, 'compressed-rollout', 'utf-8')

    await expect(prepare()).resolves.toEqual({ useRealCodexHome: true })
    expect(readFileSync(targetRolloutPath(), 'utf-8')).toBe('compressed-rollout')
  })

  it('coalesces concurrent resumes of the same legacy rollout', async () => {
    const [first, second] = await Promise.all([prepare(), prepare()])

    expect(first.useRealCodexHome).toBe(true)
    expect(second.useRealCodexHome).toBe(true)
    expect(readFileSync(targetRolloutPath(), 'utf-8')).toContain('session_meta')
  })

  it('fails clearly and retryably instead of approving a missing rollout', async () => {
    rmSync(rolloutPath)

    await expect(prepare()).rejects.toThrow(/Retry resume/)
    expect(existsSync(targetRolloutPath())).toBe(false)
  })

  it('fails closed when a different rollout already owns the target path', async () => {
    mkdirSync(join(targetRolloutPath(), '..'), { recursive: true })
    writeFileSync(targetRolloutPath(), '{"different":true}\n', 'utf-8')

    await expect(prepare()).rejects.toThrow(/Retry resume/)
    expect(readFileSync(targetRolloutPath(), 'utf-8')).toBe('{"different":true}\n')
  })

  it.each([
    ['per-account home', join(rootPlaceholder(), 'codex-accounts', 'account-1', 'home'), 'local'],
    ['custom home', join(rootPlaceholder(), 'custom-codex-home'), 'local'],
    ['WSL home', '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex', 'local'],
    ['SSH session', rootPlaceholder(), 'ssh:server-1']
  ])(
    'preserves %s without materializing it',
    async (_label, codexHomeTemplate, executionHostId) => {
      const codexHome = codexHomeTemplate.replace(rootPlaceholder(), root)
      const result = await prepareLegacySharedCodexSessionResume(
        {
          agent: 'codex',
          filePath: rolloutPath,
          codexHome,
          executionHostId: executionHostId as 'local'
        },
        options()
      )

      expect(result).toEqual({ useRealCodexHome: false })
      expect(existsSync(targetRolloutPath())).toBe(false)
    }
  )

  it.each(['managed account', 'custom CODEX_HOME'])(
    'preserves the legacy home while the %s lane is selected',
    async () => {
      const result = await prepareLegacySharedCodexSessionResume(legacyArgs(), {
        ...options(),
        isHostSystemDefaultRealHome: () => false
      })

      expect(result).toEqual({ useRealCodexHome: false })
      expect(existsSync(targetRolloutPath())).toBe(false)
    }
  )

  it('still materializes a legacy resume when an account selection exists', async () => {
    const result = await prepareLegacySharedCodexSessionResume(legacyArgs(), {
      ...options(),
      getSelectedHostAccountCodexHomePath: () => join(root, 'codex-accounts', 'account-1', 'home')
    })

    expect(result).toEqual({ useRealCodexHome: true })
  })

  function prepare() {
    return prepareLegacySharedCodexSessionResume(legacyArgs(), options())
  }

  function legacyArgs() {
    return {
      agent: 'codex' as const,
      filePath: rolloutPath,
      codexHome: legacyHome,
      executionHostId: 'local' as const
    }
  }

  function options() {
    return {
      isHostSystemDefaultRealHome: () => true,
      legacyCodexHomePath: legacyHome,
      systemCodexHomePath: systemHome
    }
  }

  function targetRolloutPath(): string {
    return join(systemHome, 'sessions', '2026', '07', '20', basename(rolloutPath))
  }
})

// Why: the session bridge hardlinks each rollout into every per-account home
// and vault dedup keeps the lexicographically-smallest alias, so a session
// recorded by the selected account can surface under a peer account's home.
describe('per-account resume repin', () => {
  let root: string
  // Deliberately ordered so the SELECTED account loses the path tie-break.
  let peerHome: string
  let selectedHome: string
  let recordedRolloutPath: string
  let bridgedRolloutPath: string

  const rolloutRelativePath = join(
    'sessions',
    '2026',
    '07',
    '20',
    'rollout-2026-07-20T10-00-00-abcdef00-1234-4321-9999-cafecafecafe.jsonl'
  )

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-account-repin-'))
    peerHome = join(root, 'codex-accounts', '11111111-aaaa-4aaa-8aaa-111111111111', 'home')
    selectedHome = join(root, 'codex-accounts', '99999999-bbbb-4bbb-8bbb-999999999999', 'home')
    recordedRolloutPath = join(selectedHome, rolloutRelativePath)
    bridgedRolloutPath = join(peerHome, rolloutRelativePath)
    mkdirSync(dirname(recordedRolloutPath), { recursive: true })
    writeFileSync(recordedRolloutPath, '{"type":"session_meta"}\n', 'utf-8')
    mkdirSync(dirname(bridgedRolloutPath), { recursive: true })
    linkSync(recordedRolloutPath, bridgedRolloutPath)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it.each([['recorded rollout first'], ['bridged alias first']])(
    'repins the surviving vault row to the selected account, discovered %s',
    async (order) => {
      const recorded = rolloutCandidate(recordedRolloutPath, selectedHome)
      const bridged = rolloutCandidate(bridgedRolloutPath, peerHome)
      const survivors = dedupeCodexRolloutFileAliases(
        order === 'recorded rollout first' ? [recorded, bridged] : [bridged, recorded],
        rolloutCandidateAccessors
      )

      // The dedup pick is order-independent: the peer's alias wins the tie-break.
      expect(survivors).toEqual([bridged])

      const result = await prepareLegacySharedCodexSessionResume(
        {
          agent: 'codex',
          filePath: bridged.filePath,
          codexHome: peerHome,
          executionHostId: 'local'
        },
        repinOptions()
      )

      expect(result).toEqual({ useRealCodexHome: false, substituteCodexHome: selectedHome })
    }
  )

  it('keeps the home of a row that already names the selected account', async () => {
    const result = await prepareLegacySharedCodexSessionResume(
      {
        agent: 'codex',
        filePath: recordedRolloutPath,
        codexHome: selectedHome,
        executionHostId: 'local'
      },
      repinOptions()
    )

    expect(result).toEqual({ useRealCodexHome: false })
  })

  it('declines while the system default is selected', async () => {
    const result = await prepareLegacySharedCodexSessionResume(
      {
        agent: 'codex',
        filePath: bridgedRolloutPath,
        codexHome: peerHome,
        executionHostId: 'local'
      },
      { ...repinOptions(), getSelectedHostAccountCodexHomePath: () => null }
    )

    expect(result).toEqual({ useRealCodexHome: false })
  })

  it('declines while the bridge has not yet linked the rollout into the selected home', async () => {
    const unbridgedSelectedHome = join(
      root,
      'codex-accounts',
      'ffffffff-cccc-4ccc-8ccc-ffffffffffff',
      'home'
    )
    mkdirSync(unbridgedSelectedHome, { recursive: true })

    const result = await prepareLegacySharedCodexSessionResume(
      {
        agent: 'codex',
        filePath: bridgedRolloutPath,
        codexHome: peerHome,
        executionHostId: 'local'
      },
      { ...repinOptions(), getSelectedHostAccountCodexHomePath: () => unbridgedSelectedHome }
    )

    expect(result).toEqual({ useRealCodexHome: false })
  })

  it('refuses when the selected rollout is temporarily unreadable', async () => {
    lstatFaults.path = recordedRolloutPath

    await expect(
      prepareLegacySharedCodexSessionResume(
        {
          agent: 'codex',
          filePath: bridgedRolloutPath,
          codexHome: peerHome,
          executionHostId: 'local'
        },
        repinOptions()
      )
    ).rejects.toBeInstanceOf(ManagedCodexHomeTemporarilyUnavailableError)
  })

  it('declines a session owned by another host', async () => {
    const result = await prepareLegacySharedCodexSessionResume(
      {
        agent: 'codex',
        filePath: bridgedRolloutPath,
        codexHome: peerHome,
        executionHostId: 'ssh:server-1' as 'local'
      },
      repinOptions()
    )

    expect(result).toEqual({ useRealCodexHome: false })
  })

  it('does not consult the host selection while resuming a WSL account session', async () => {
    const wslHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\.local\\share\\orca\\codex-accounts\\account-1\\home'
    const result = await prepareLegacySharedCodexSessionResume(
      {
        agent: 'codex',
        filePath: `${wslHome}\\sessions\\2026\\07\\20\\rollout-session.jsonl`,
        codexHome: wslHome,
        executionHostId: 'local'
      },
      {
        ...repinOptions(),
        getSelectedHostAccountCodexHomePath: () => {
          throw new Error('host lane must not be consulted')
        }
      }
    )

    expect(result).toEqual({ useRealCodexHome: false })
  })

  it('declines a transcript outside the dated rollout layout', async () => {
    const straySessionPath = join(peerHome, 'sessions', 'stray.jsonl')
    writeFileSync(straySessionPath, '{"type":"session_meta"}\n', 'utf-8')

    const result = await prepareLegacySharedCodexSessionResume(
      {
        agent: 'codex',
        filePath: straySessionPath,
        codexHome: peerHome,
        executionHostId: 'local'
      },
      repinOptions()
    )

    expect(result).toEqual({ useRealCodexHome: false })
  })

  function repinOptions() {
    return {
      isHostSystemDefaultRealHome: () => false,
      getSelectedHostAccountCodexHomePath: () => selectedHome
    }
  }

  function rolloutCandidate(filePath: string, codexHome: string) {
    const stat = statSync(filePath)
    return {
      filePath,
      codexHome,
      file: { dev: stat.dev, ino: stat.ino, nlink: stat.nlink }
    }
  }
})

const rolloutCandidateAccessors = {
  isCodex: () => true,
  getFilePath: (candidate: { filePath: string }) => candidate.filePath,
  getCodexHome: (candidate: { codexHome: string }) => candidate.codexHome,
  getHardlinkIdentity: (candidate: { file: { dev: number; ino: number; nlink: number } }) =>
    codexRolloutHardlinkIdentity(candidate.file)
}

function rootPlaceholder(): string {
  return '__ROOT__'
}
