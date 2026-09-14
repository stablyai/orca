import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeRegex } from '../../shared/string-utils'
import {
  computeTrustedHash,
  escapeTomlString,
  upsertHookTrustEntries,
  type CodexTrustEntry
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

describe('upsertHookTrustEntries', () => {
  it('creates the file with a trust block when none exists', () => {
    const entry: CodexTrustEntry = {
      sourcePath: '/foo/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: '/bin/echo hi'
    }
    upsertHookTrustEntries(configPath, [entry])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain(`[hooks.state."/foo/hooks.json:pre_tool_use:0:0"]`)
    expect(written).toContain('enabled = true')
    expect(written).toContain(`trusted_hash = "${computeTrustedHash(entry)}"`)
  })

  it('appends to an existing config without disturbing prior content', () => {
    const original = [
      'model = "gpt-5.5"',
      'approval_policy = "never"',
      '',
      '[features]',
      'hooks = true',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'session_start',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo hello'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written.startsWith(original.trimEnd())).toBe(true)
    expect(written).toContain('[hooks.state."/x/hooks.json:session_start:0:0"]')
  })

  it('replaces an existing block keyed at the same path without touching unrelated blocks', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      '[features]',
      'hooks = true',
      '',
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:STALE"',
      '',
      '[unrelated]',
      'value = 42',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo new'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain('STALE')
    expect(written).toContain('[unrelated]')
    expect(written).toContain('value = 42')
    // Why: we only own the [hooks.state."<key>"] block — [features] must be untouched.
    expect(written).toContain('[features]\nhooks = true')
  })

  it('writes a single block per entry even when called repeatedly', () => {
    const entry: CodexTrustEntry = {
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo'
    }
    upsertHookTrustEntries(configPath, [entry])
    upsertHookTrustEntries(configPath, [entry])
    upsertHookTrustEntries(configPath, [entry])

    const written = readFileSync(configPath, 'utf-8')
    const occurrences = written.match(/\[hooks\.state\./g) ?? []
    expect(occurrences).toHaveLength(1)
  })

  it('collapses duplicate blocks for the same hook key while preserving unrelated hook state', () => {
    const sourcePath = 'C:\\Users\\me\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\hooks.json'
    const key = `${sourcePath}:session_start:0:0`
    const unrelatedSourcePath =
      'C:\\Users\\me\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\hooks.json'
    const unrelatedKey = `${unrelatedSourcePath}:stop:0:0`
    const original = [
      `[hooks.state."${escapeTomlString(key)}"]`,
      'enabled = true',
      'trusted_hash = "sha256:STALE1"',
      '',
      `[hooks.state."${escapeTomlString(unrelatedKey)}"]`,
      'enabled = true',
      'trusted_hash = "sha256:KEEP"',
      '',
      `[hooks.state."${escapeTomlString(key)}"]`,
      'enabled = false',
      'trusted_hash = "sha256:STALE2"',
      ''
    ].join('\r\n')
    writeFileSync(configPath, original, 'utf-8')

    const entry: CodexTrustEntry = {
      sourcePath,
      eventLabel: 'session_start',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo session'
    }
    upsertHookTrustEntries(configPath, [entry])

    const written = readFileSync(configPath, 'utf-8')
    const duplicateKeyOccurrences = written.match(
      new RegExp(`\\[hooks\\.state\\.'${escapeRegex(key)}'\\]`, 'g')
    )
    expect(duplicateKeyOccurrences).toHaveLength(1)
    // The unrelated key was not upserted and stays in its original escaped form.
    expect(written).toContain(`[hooks.state."${escapeTomlString(unrelatedKey)}"]`)
    expect(written).toContain('trusted_hash = "sha256:KEEP"')
    expect(written).toContain('enabled = false')
    expect(written).not.toContain('STALE1')
    expect(written).not.toContain('STALE2')
    expect(written).toContain(`trusted_hash = "${computeTrustedHash(entry)}"`)
  })

  it('collapses a literal-string hook table before writing the canonical Codex literal table', () => {
    const sourcePath = 'C:\\Users\\me\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\hooks.json'
    const key = `${sourcePath}:session_start:0:0`
    const original = [
      `[hooks.state.'${key}']`,
      'enabled = false',
      'trusted_hash = "sha256:LITERAL"',
      ''
    ].join('\r\n')
    writeFileSync(configPath, original, 'utf-8')

    const entry: CodexTrustEntry = {
      sourcePath,
      eventLabel: 'session_start',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo session'
    }
    upsertHookTrustEntries(configPath, [entry])

    const written = readFileSync(configPath, 'utf-8')
    expect(written.match(/\[hooks\.state\./g)).toHaveLength(2)
    expect(written).toContain(`[hooks.state.'${key}']`)
    expect(written).toContain(`[hooks.state.'${key.replace(/\\/g, '/')}']`)
    expect(written).toContain('enabled = false')
    expect(written).toContain(`trusted_hash = "${computeTrustedHash(entry)}"`)
  })

  it('writes a .bak file before overwriting an existing config', () => {
    writeFileSync(configPath, 'model = "old"\n', 'utf-8')
    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo'
      }
    ])
    expect(existsSync(`${configPath}.bak`)).toBe(true)
    expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe('model = "old"\n')
  })

  it.skipIf(process.platform === 'win32')('does not follow an existing .bak symlink', () => {
    const original = 'model = "old"\n'
    const backupTarget = join(tmpDir, 'dotfiles-config-backup.toml')
    writeFileSync(configPath, original, 'utf-8')
    writeFileSync(backupTarget, 'pristine backup target\n', 'utf-8')
    symlinkSync(backupTarget, `${configPath}.bak`)

    expect(() =>
      upsertHookTrustEntries(configPath, [
        {
          sourcePath: '/x/hooks.json',
          eventLabel: 'pre_tool_use',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'echo'
        }
      ])
    ).toThrow('Refusing to overwrite symlinked backup')

    expect(readFileSync(configPath, 'utf-8')).toBe(original)
    expect(lstatSync(`${configPath}.bak`).isSymbolicLink()).toBe(true)
    expect(readFileSync(backupTarget, 'utf-8')).toBe('pristine backup target\n')
  })

  it('does not write at all when the file already has the right hash', () => {
    const entry: CodexTrustEntry = {
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo'
    }
    upsertHookTrustEntries(configPath, [entry])
    const firstWrite = readFileSync(configPath, 'utf-8')
    // Why: a no-op upsert must not roll .bak forward, or repeated calls destroy the last recoverable copy.
    rmSync(`${configPath}.bak`, { force: true })
    upsertHookTrustEntries(configPath, [entry])
    expect(existsSync(`${configPath}.bak`)).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).toBe(firstWrite)
  })

  it('replaces a stale block written with CRLF line endings without duplicating', () => {
    // Why: regression — \r\n in the existing config made the header pattern miss and append a duplicate.
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      '[features]',
      'hooks = true',
      '',
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:STALE"',
      ''
    ].join('\r\n')
    writeFileSync(configPath, original, 'utf-8')

    const entry: CodexTrustEntry = {
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo new'
    }
    upsertHookTrustEntries(configPath, [entry])

    const written = readFileSync(configPath, 'utf-8')
    const occurrences = written.match(/\[hooks\.state\./g) ?? []
    expect(occurrences).toHaveLength(1)
    expect(written).not.toContain('STALE')
    expect(written).toContain(`trusted_hash = "${computeTrustedHash(entry)}"`)
  })

  it('preserves an immediately-adjacent unrelated hooks.state block', () => {
    const targetKey = '/x/hooks.json:pre_tool_use:0:0'
    const neighborKey = '/y/hooks.json:post_tool_use:0:0'
    const original = [
      `[hooks.state."${targetKey}"]`,
      'enabled = true',
      'trusted_hash = "sha256:STALE"',
      `[hooks.state."${neighborKey}"]`,
      'enabled = true',
      'trusted_hash = "sha256:NEIGHBOR"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo new'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain('STALE')
    expect(written).toContain(`[hooks.state."${neighborKey}"]`)
    expect(written).toContain('trusted_hash = "sha256:NEIGHBOR"')
    // Neighbor's `enabled = true` should still be paired with NEIGHBOR's hash.
    const neighborIdx = written.indexOf(`[hooks.state."${neighborKey}"]`)
    expect(written.slice(neighborIdx)).toMatch(/enabled = true[\s\S]*sha256:NEIGHBOR/)
  })

  it('preserves an unrelated table whose quoted key contains a `]`', () => {
    const original = ['[other."a]b"]', 'foo = 1', ''].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('[other."a]b"]')
    expect(written).toContain('foo = 1')
  })

  // Why: TOML allows literal-string quoted keys, so header detection must respect `]` inside `'...'`.
  it('preserves an unrelated table whose literal-string key contains a `]`', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:STALE"',
      "[other.'a]b']",
      'foo = 1',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo new'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain('STALE')
    expect(written).toContain("[other.'a]b']")
    expect(written).toContain('foo = 1')
  })

  it('does not treat `[fake]` inside a multi-line basic string as a header', () => {
    const original = [
      'model = "gpt"',
      'description = """',
      'This text has a fake header:',
      '[fake]',
      'inside it.',
      '"""',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain(
      ['description = """', 'This text has a fake header:', '[fake]', 'inside it.', '"""'].join(
        '\n'
      )
    )
  })

  it('does not treat the target hook header inside a multi-line basic string as a duplicate', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:STALE"',
      '',
      '[notes]',
      'body = """',
      `[hooks.state."${key}"]`,
      'is only documentation here.',
      '"""',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain(
      ['body = """', `[hooks.state."${key}"]`, 'is only documentation here.', '"""'].join('\n')
    )
    expect(written).toContain('[notes]')
    expect(written).not.toContain('sha256:STALE')
  })

  it('does not let triple quotes in comments hide an existing trust block', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      '# user note mentions triple quote: """',
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:STALE"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('# user note mentions triple quote: """')
    expect(written.match(/\[hooks\.state\."/g)).toHaveLength(1)
    expect(written).not.toContain('sha256:STALE')
  })

  it('does not let triple quotes in single-line strings hide an existing trust block', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      'note = "\\"\\"\\""',
      'literal_note = \'"""\'',
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:STALE"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('note = "\\"\\"\\""')
    expect(written).toContain('literal_note = \'"""\'')
    expect(written.match(/\[hooks\.state\."/g)).toHaveLength(1)
    expect(written).not.toContain('sha256:STALE')
  })

  it('treats `\\"""` inside a multi-line basic string as an escaped quote, not a close', () => {
    // Why: `\"` escapes in a multi-line basic string must not be misread as closing early.
    const original = [
      'prompt = """',
      'use \\"\\"\\" carefully',
      '"""',
      '',
      '[other]',
      'x = 1',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain(['prompt = """', 'use \\"\\"\\" carefully', '"""'].join('\n'))
    expect(written).toContain('[other]\nx = 1')
    expect(written).toContain('[hooks.state."/x/hooks.json:pre_tool_use:0:0"]')
  })

  it('escapes literal `"` and `\\` in non-Windows source paths inside the trust block header', () => {
    // Why: a backslash in a POSIX path is a literal filename char, so escape it instead of normalizing.
    const entry: CodexTrustEntry = {
      sourcePath: '/x/with"quote\\and\\back/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo'
    }
    upsertHookTrustEntries(configPath, [entry])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain(
      `[hooks.state."/x/with\\"quote\\\\and\\\\back/hooks.json:pre_tool_use:0:0"]`
    )
  })

  it('overwrites an existing block whose header has leading whitespace (TOML allows indent)', () => {
    // Why: regression — buildHeaderPattern required column-0 headers but the reader accepts indented ones.
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = ` [hooks.state."${key}"]\nenabled = true\ntrusted_hash = "sha256:OLD"\n`
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo hi'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    const headerCount = (written.match(/\[hooks\.state\."/g) ?? []).length
    expect(headerCount).toBe(1)
    expect(written).not.toContain('sha256:OLD')
  })

  it('preserves `enabled = false` when the user hand-edited it before reinstall', () => {
    // Why: regression — auto-install used to clobber a hand-disabled hook back to enabled = true.
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = `[hooks.state."${key}"]\nenabled = false\ntrusted_hash = "sha256:OLD"\n`
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo hi'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('enabled = false')
    expect(written).not.toContain('enabled = true')
  })

  it('overwrites an existing block when the file ends without a trailing newline', () => {
    // Why: regression — buildHeaderPattern required a trailing newline, appending a duplicate at EOF.
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = `[hooks.state."${key}"]\nenabled = true\ntrusted_hash = "sha256:OLD"`
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo hi'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    const headerCount = (written.match(/\[hooks\.state\."/g) ?? []).length
    expect(headerCount).toBe(1)
    expect(written).not.toContain('sha256:OLD')
  })

  it('overwrites an existing block whose header has an inline comment', () => {
    // Why: regression — buildHeaderPattern missed TOML-valid trailing comments and appended a duplicate block.
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = `[hooks.state."${key}"] # user note\nenabled = true\ntrusted_hash = "sha256:OLD"\n`
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo hi'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    const headerCount = (written.match(/\[hooks\.state\."/g) ?? []).length
    expect(headerCount).toBe(1)
    expect(written).not.toContain('sha256:OLD')
  })

  it('finds and replaces a legacy forward-slash block when Orca upserts with native backslash key', () => {
    // Why: Codex 0.140 exposes Windows keys with either separator depending on cwd, so replace both.
    const backslashPath = 'C:\\Users\\Rod\\AppData\\Roaming\\orca\\hooks.json'
    const legacyKey = `${backslashPath.replace(/\\/g, '/')}:session_start:0:0`
    const original = [
      `[hooks.state."${legacyKey}"]`,
      'enabled = true',
      'trusted_hash = "sha256:CODEX-WRITTEN"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const entry: CodexTrustEntry = {
      sourcePath: backslashPath,
      eventLabel: 'session_start',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo session'
    }
    upsertHookTrustEntries(configPath, [entry])

    const written = readFileSync(configPath, 'utf-8')
    expect((written.match(/\[hooks\.state\./g) ?? []).length).toBe(2)
    expect(written).toContain(`[hooks.state.'${backslashPath}:session_start:0:0']`)
    expect(written).toContain(`[hooks.state.'${legacyKey}']`)
    expect(written).not.toContain('sha256:CODEX-WRITTEN')
    expect(written).toContain(`trusted_hash = "${computeTrustedHash(entry)}"`)
  })

  it('produces exactly one Windows separator pair after two consecutive upserts', () => {
    // Why: idempotency guard — repeated auto-install must not accumulate duplicate blocks.
    const entry: CodexTrustEntry = {
      sourcePath: 'C:\\Users\\Rod\\AppData\\Roaming\\orca\\hooks.json',
      eventLabel: 'session_start',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo session'
    }
    upsertHookTrustEntries(configPath, [entry])
    upsertHookTrustEntries(configPath, [entry])

    const written = readFileSync(configPath, 'utf-8')
    expect((written.match(/\[hooks\.state\./g) ?? []).length).toBe(2)
    expect((written.match(/session_start:0:0/g) ?? []).length).toBe(2)
  })

  it('falls back to TOML basic-string headers when a Windows path contains an apostrophe', () => {
    // Why: TOML literal-string keys can't hold apostrophes, but Windows profile paths can.
    const entry: CodexTrustEntry = {
      sourcePath: "C:\\Users\\O'Connor\\AppData\\Roaming\\orca\\hooks.json",
      eventLabel: 'session_start',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo session'
    }
    upsertHookTrustEntries(configPath, [entry])

    const written = readFileSync(configPath, 'utf-8')
    expect((written.match(/\[hooks\.state\."/g) ?? []).length).toBe(2)
    expect(written).toContain(
      `[hooks.state."C:\\\\Users\\\\O'Connor\\\\AppData\\\\Roaming\\\\orca\\\\hooks.json:session_start:0:0"]`
    )
    expect(written).toContain(
      `[hooks.state."C:/Users/O'Connor/AppData/Roaming/orca/hooks.json:session_start:0:0"]`
    )
    expect(written).not.toContain(`[hooks.state.'C:\\Users\\O'Connor`)
  })

  it('finds a Codex-written block with lowercased username when Orca key has mixed-case username', () => {
    // Why: realpathSync.native casing can differ from what Codex wrote, so case-fold to replace not duplicate.
    const lowercasePath = 'C:\\Users\\rod\\AppData\\Roaming\\orca\\hooks.json'
    const mixedCasePath = 'C:\\Users\\Rod\\AppData\\Roaming\\orca\\hooks.json'
    const literalKey = `${lowercasePath}:session_start:0:0`
    const original = [
      `[hooks.state.'${literalKey}']`,
      'enabled = true',
      'trusted_hash = "sha256:LOWERCASE"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const entry: CodexTrustEntry = {
      sourcePath: mixedCasePath,
      eventLabel: 'session_start',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo session'
    }
    upsertHookTrustEntries(configPath, [entry])

    const written = readFileSync(configPath, 'utf-8')
    expect((written.match(/\[hooks\.state\./g) ?? []).length).toBe(2)
    expect(written).not.toContain('sha256:LOWERCASE')
    expect(written).toContain(`trusted_hash = "${computeTrustedHash(entry)}"`)
  })
})
describe('upsertHookTrustEntries with array-of-tables boundaries', () => {
  // Why: [[array.of.tables]] must count as a block boundary, else upsert/remove eats past array entries.
  it('stops the replacement at a following [[array.of.tables]] header', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:STALE"',
      '',
      '[[products]]',
      'name = "thing"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    upsertHookTrustEntries(configPath, [
      {
        sourcePath: '/x/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo'
      }
    ])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain('STALE')
    expect(written).toContain('[[products]]')
    expect(written).toContain('name = "thing"')
  })
})
