import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  escapeTomlString,
  normalizeCodexProjectPathForLookup,
  normalizeCodexProjectPathForRevocationLookup,
  upsertProjectTrustLevel,
  upsertProjectTrustLevelInContent
} from './config-toml-trust'
import {
  createTrustConfigFixture,
  removeTrustConfigFixture
} from './config-toml-trust-test-fixtures'

let tmpDir: string
let configPath: string

beforeEach(() => {
  const fixture = createTrustConfigFixture()
  tmpDir = fixture.tmpDir
  configPath = fixture.configPath
})

afterEach(() => {
  removeTrustConfigFixture(tmpDir)
})

describe('upsertProjectTrustLevel', () => {
  it('creates a projects trust block when the config is empty', () => {
    expect(upsertProjectTrustLevelInContent('', '/tmp/codex-ws', 'trusted')).toBe(
      ['[projects."/tmp/codex-ws"]', 'trust_level = "trusted"', ''].join('\n')
    )
  })

  it('uses Codex canonicalized project paths when the project exists', () => {
    const nestedDir = join(tmpDir, 'nested')
    const projectDir = join(tmpDir, 'project')
    mkdirSync(nestedDir)
    mkdirSync(projectDir)
    const aliasedProjectPath = join(nestedDir, '..', 'project')
    const trustedPath = realpathSync.native(aliasedProjectPath)
    const trustedTomlPath = escapeTomlString(trustedPath)

    expect(upsertProjectTrustLevelInContent('', aliasedProjectPath, 'trusted')).toBe(
      [`[projects."${trustedTomlPath}"]`, 'trust_level = "trusted"', ''].join('\n')
    )
  })

  it('updates an existing project block without touching unrelated keys', () => {
    const original = [
      'model = "gpt-5.5"',
      '',
      '[projects."/tmp/codex-ws"]',
      'notes = "keep"',
      'trust_level = "untrusted"',
      '',
      '[profiles.default]',
      'sandbox_mode = "workspace-write"',
      ''
    ].join('\n')

    const updated = upsertProjectTrustLevelInContent(original, '/tmp/codex-ws', 'trusted')

    expect(updated).toContain('model = "gpt-5.5"')
    expect(updated).toContain('[projects."/tmp/codex-ws"]\nnotes = "keep"')
    expect(updated).toContain('trust_level = "trusted"')
    expect(updated).not.toContain('trust_level = "untrusted"')
    expect(updated).toContain('[profiles.default]\nsandbox_mode = "workspace-write"')
  })

  it('adds trust_level to an existing project block that does not have one', () => {
    const original = [
      '[projects."/tmp/codex-ws"]',
      'notes = "keep"',
      '',
      '[other]',
      'value = 1',
      ''
    ].join('\n')

    const updated = upsertProjectTrustLevelInContent(original, '/tmp/codex-ws', 'trusted')

    expect(updated).toContain(
      ['[projects."/tmp/codex-ws"]', 'trust_level = "trusted"', 'notes = "keep"'].join('\n')
    )
    expect(updated).toContain('[other]\nvalue = 1')
  })

  it('preserves CRLF endings and writes native Windows path separators in the header', () => {
    // Why: local trust follows Codex's realpath; remote trust preserves the SSH provider's canonical path.
    const original = ['[profiles.default]', 'model = "gpt-5"', ''].join('\r\n')

    const updated = upsertProjectTrustLevelInContent(original, 'C:\\Users\\nw\\repo', 'trusted')

    expect(updated).toContain(
      ['[projects."C:\\\\Users\\\\nw\\\\repo"]', 'trust_level = "trusted"', ''].join('\r\n')
    )
    expect(updated).toContain('[profiles.default]\r\nmodel = "gpt-5"')
  })

  it('updates an existing Windows backslash project block after separator normalization', () => {
    // Why: hook trust writes paired Windows variants, but project trust still repairs a single table in place.
    const original = [
      '[projects."C:\\\\Users\\\\nw\\\\repo"]',
      'notes = "keep"',
      'trust_level = "untrusted"',
      ''
    ].join('\n')

    const updated = upsertProjectTrustLevelInContent(original, 'C:\\Users\\nw\\repo', 'trusted')

    expect(updated.match(/\[projects\./g)).toHaveLength(1)
    expect(updated).toContain('[projects."C:\\\\Users\\\\nw\\\\repo"]')
    expect(updated).toContain('notes = "keep"')
    expect(updated).toContain('trust_level = "trusted"')
    expect(updated).not.toContain('trust_level = "untrusted"')
  })

  it('updates an existing legacy Windows forward-slash project block', () => {
    // Why: older Orca builds normalized to forward slashes; backslash fixes must not duplicate them.
    const original = [
      '[projects."C:/Users/nw/repo"]',
      'notes = "keep"',
      'trust_level = "untrusted"',
      ''
    ].join('\n')

    const updated = upsertProjectTrustLevelInContent(original, 'C:\\Users\\nw\\repo', 'trusted')

    expect(updated.match(/\[projects\./g)).toHaveLength(1)
    expect(updated).toContain('[projects."C:/Users/nw/repo"]')
    expect(updated).toContain('notes = "keep"')
    expect(updated).toContain('trust_level = "trusted"')
    expect(updated).not.toContain('trust_level = "untrusted"')
  })

  it('updates a Codex literal-string Windows project block without duplicating it', () => {
    const original = ["[projects.'c:\\gemini_etl']", 'trust_level = "untrusted"', ''].join('\n')

    const updated = upsertProjectTrustLevelInContent(original, 'c:\\gemini_etl', 'trusted', {
      alreadyCanonical: true
    })

    expect(updated.match(/\[projects\./g)).toHaveLength(1)
    expect(updated).toContain("[projects.'c:\\gemini_etl']")
    expect(updated).toContain('trust_level = "trusted"')
    expect(updated).not.toContain('[projects."c:\\\\gemini_etl"]')
  })

  it.each([
    {
      name: 'drive-letter casing and separators',
      existingPath: 'c:\\work\\repo',
      incomingPath: 'C:/work/repo'
    },
    {
      name: 'WSL UNC path casing and separators',
      existingPath: '\\\\wsl$\\Ubuntu\\home\\u\\proj',
      incomingPath: '//WSL$/ubuntu/home/u/proj'
    },
    {
      name: 'server UNC path casing and separators',
      existingPath: '\\\\server\\share\\proj',
      incomingPath: '//SERVER/share/proj'
    }
  ])('matches $name by decoded Windows path value', ({ existingPath, incomingPath }) => {
    const original = [`[projects.'${existingPath}']`, 'trust_level = "untrusted"', ''].join('\n')

    const updated = upsertProjectTrustLevelInContent(original, incomingPath, 'trusted', {
      alreadyCanonical: true
    })

    expect(updated.match(/\[projects\./g)).toHaveLength(1)
    expect(updated).toContain(`[projects.'${existingPath}']`)
    expect(updated).toContain('trust_level = "trusted"')
  })

  it('keeps case-distinct WSL Linux project paths as separate trust blocks', () => {
    // Why: \\wsl$\<distro> is case-insensitive but the Linux path under it is not — two distinct projects.
    const existingPath = '\\\\wsl$\\Ubuntu\\home\\u\\Repo'
    const incomingPath = '\\\\wsl$\\Ubuntu\\home\\u\\repo'
    const original = [`[projects.'${existingPath}']`, 'trust_level = "untrusted"', ''].join('\n')

    const updated = upsertProjectTrustLevelInContent(original, incomingPath, 'trusted', {
      alreadyCanonical: true
    })

    expect(updated.match(/\[projects\./g)).toHaveLength(2)
    expect(updated).toContain(`[projects.'${existingPath}']`)
    // Why: serializer writes basic-string headers via escapeTomlString; assert that exact form.
    expect(updated).toContain(`[projects."${escapeTomlString(incomingPath)}"]`)
    expect(updated).toContain('trust_level = "untrusted"')
    expect(updated).toContain('trust_level = "trusted"')
  })

  it('updates the same WSL project block across wsl$ and wsl.localhost spellings', () => {
    // Why: the two share spellings alias the same distro, so a revoke must not survive under the other.
    const original = [
      "[projects.'\\\\wsl$\\Ubuntu\\home\\u\\proj']",
      'trust_level = "untrusted"',
      ''
    ].join('\n')

    const updated = upsertProjectTrustLevelInContent(
      original,
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj',
      'trusted',
      { alreadyCanonical: true }
    )

    expect(updated.match(/\[projects\./g)).toHaveLength(1)
    expect(updated).toContain("[projects.'\\\\wsl$\\Ubuntu\\home\\u\\proj']")
    expect(updated).toContain('trust_level = "trusted"')
    expect(updated).not.toContain('trust_level = "untrusted"')
  })

  it('matches a literal-string POSIX project path containing a quote and backslash', () => {
    const projectPath = '/tmp/with"quote\\and-backslash'
    const original = [`[projects.'${projectPath}']`, 'trust_level = "untrusted"', ''].join('\n')

    const updated = upsertProjectTrustLevelInContent(original, projectPath, 'trusted', {
      alreadyCanonical: true
    })

    expect(updated.match(/\[projects\./g)).toHaveLength(1)
    expect(updated).toContain(`[projects.'${projectPath}']`)
    expect(updated).toContain('trust_level = "trusted"')
  })

  it('preserves an already-canonical remote Windows project path', () => {
    // Why: SSH paths resolve on the remote; local realpath would canonicalize the wrong machine.
    const updated = upsertProjectTrustLevelInContent('', 'C:/Users/nw/repo', 'trusted', {
      alreadyCanonical: true
    })

    expect(updated).toBe(
      ['[projects."C:/Users/nw/repo"]', 'trust_level = "trusted"', ''].join('\n')
    )
  })

  it('writes config.toml and avoids rewriting an already-trusted project', () => {
    upsertProjectTrustLevel(configPath, '/tmp/codex-ws', 'trusted')
    const firstWrite = readFileSync(configPath, 'utf-8')

    rmSync(`${configPath}.bak`, { force: true })
    upsertProjectTrustLevel(configPath, '/tmp/codex-ws', 'trusted')

    expect(readFileSync(configPath, 'utf-8')).toBe(firstWrite)
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })
})

describe('normalizeCodexProjectPathForLookup', () => {
  it('dedupes drive-letter casing and separators for true Windows paths', () => {
    expect(normalizeCodexProjectPathForLookup('C:\\repo')).toBe(
      normalizeCodexProjectPathForLookup('c:/repo')
    )
  })

  it('keeps case-distinct WSL Linux paths distinct', () => {
    expect(normalizeCodexProjectPathForLookup('\\\\wsl$\\Ubuntu\\home\\u\\Repo')).not.toBe(
      normalizeCodexProjectPathForLookup('\\\\wsl$\\Ubuntu\\home\\u\\repo')
    )
  })

  it('merges separator and distro-casing variants of the same WSL path', () => {
    // Why: separator and \\wsl$\<distro> casing may drift, but the same Linux path is one trust key.
    expect(normalizeCodexProjectPathForLookup('\\\\wsl$\\Ubuntu\\home\\u\\proj')).toBe(
      normalizeCodexProjectPathForLookup('//WSL$/ubuntu/home/u/proj')
    )
  })

  it('treats wsl.localhost like the wsl$ share for the case-sensitive tail', () => {
    expect(normalizeCodexProjectPathForLookup('\\\\wsl.localhost\\Ubuntu\\home\\u\\Repo')).not.toBe(
      normalizeCodexProjectPathForLookup('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo')
    )
    expect(normalizeCodexProjectPathForLookup('\\\\WSL.LOCALHOST\\Ubuntu\\home\\u\\proj')).toBe(
      normalizeCodexProjectPathForLookup('//wsl.localhost/ubuntu/home/u/proj')
    )
  })

  it('folds the wsl$ and wsl.localhost spellings of the same path to one key', () => {
    expect(normalizeCodexProjectPathForLookup('\\\\wsl$\\Ubuntu\\home\\u\\Proj')).toBe(
      normalizeCodexProjectPathForLookup('\\\\wsl.localhost\\Ubuntu\\home\\u\\Proj')
    )
  })

  it('folds drvfs automount tails case-insensitively like the native drive path', () => {
    // Why: /mnt/<drive> is NTFS through drvfs, case-insensitive like C:\ itself.
    expect(normalizeCodexProjectPathForLookup('\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\Bob\\Repo')).toBe(
      normalizeCodexProjectPathForLookup('//wsl.localhost/ubuntu/mnt/c/users/bob/repo')
    )
    // /mnt/wsl is tmpfs, not a drvfs drive mount — its tail stays case-sensitive.
    expect(normalizeCodexProjectPathForLookup('\\\\wsl$\\Ubuntu\\mnt\\wsl\\Repo')).not.toBe(
      normalizeCodexProjectPathForLookup('\\\\wsl$\\Ubuntu\\mnt\\wsl\\repo')
    )
  })

  it('still case-folds normal UNC shares', () => {
    expect(normalizeCodexProjectPathForLookup('\\\\server\\share\\Proj')).toBe(
      normalizeCodexProjectPathForLookup('//SERVER/share/proj')
    )
  })

  it('leaves POSIX paths untouched', () => {
    expect(normalizeCodexProjectPathForLookup('/home/u/Repo')).toBe('/home/u/Repo')
  })
})

describe('normalizeCodexProjectPathForRevocationLookup', () => {
  it('folds WSL tails fully so drifted-case legacy revocations still match', () => {
    expect(normalizeCodexProjectPathForRevocationLookup('\\\\wsl$\\Ubuntu\\home\\u\\Repo')).toBe(
      normalizeCodexProjectPathForRevocationLookup('//wsl.localhost/ubuntu/home/u/repo')
    )
  })

  it('keeps POSIX paths case-sensitive', () => {
    expect(normalizeCodexProjectPathForRevocationLookup('/home/u/Repo')).not.toBe(
      normalizeCodexProjectPathForRevocationLookup('/home/u/repo')
    )
  })
})
