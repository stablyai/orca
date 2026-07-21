import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareLegacySharedCodexSessionResume } from './codex-legacy-session-resume'

describe('prepareLegacySharedCodexSessionResume', () => {
  let root: string
  let legacyHome: string
  let systemHome: string
  let rolloutPath: string

  beforeEach(() => {
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
    rmSync(root, { recursive: true, force: true })
  })

  it('materializes an immediate legacy resume into the real home', async () => {
    const result = await prepare()
    const targetPath = targetRolloutPath()

    expect(result).toEqual({ useRealCodexHome: true })
    expect(readFileSync(targetPath, 'utf-8')).toBe('{"type":"session_meta"}\n')
    expect(statSync(targetPath).ino).toBe(statSync(rolloutPath).ino)
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
    return join(
      systemHome,
      'sessions',
      '2026',
      '07',
      '20',
      'rollout-2026-07-20T12-00-00-session.jsonl'
    )
  }
})

function rootPlaceholder(): string {
  return '__ROOT__'
}
