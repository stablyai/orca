import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import {
  readHookTrustEntries,
  readHookTrustEntriesFromContent,
  removeHookTrustEntriesFromContent
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

describe('readHookTrustEntries', () => {
  it('returns an empty map when the file does not exist', () => {
    const result = readHookTrustEntries(configPath)
    expect(result.size).toBe(0)
  })

  it('returns key→hash entries for each [hooks.state."<key>"] block', () => {
    const keyA = '/x/hooks.json:pre_tool_use:0:0'
    const keyB = '/y/hooks.json:post_tool_use:1:0'
    const original = [
      `[hooks.state."${keyA}"]`,
      'enabled = true',
      'trusted_hash = "sha256:AAA"',
      '',
      `[hooks.state."${keyB}"]`,
      'enabled = true',
      'trusted_hash = "sha256:BBB"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.size).toBe(2)
    expect(result.get(keyA)?.trustedHash).toBe('sha256:AAA')
    expect(result.get(keyA)?.enabled).toBe(true)
    expect(result.get(keyB)?.trustedHash).toBe('sha256:BBB')
    expect(result.get(keyB)?.enabled).toBe(true)
  })

  it('fails closed when normalized duplicate blocks have conflicting hashes', () => {
    const key = '/x/hooks.json:stop:0:0'
    writeFileSync(
      configPath,
      [
        `[hooks.state."${key}"]`,
        'trusted_hash = "sha256:USER"',
        '',
        `[hooks.state.'${key}']`,
        'trusted_hash = "sha256:ORCA"',
        ''
      ].join('\n'),
      'utf-8'
    )

    expect(readHookTrustEntries(configPath).get(key)?.trustedHash).toBeUndefined()
  })

  it('ignores trust-looking fields inside multiline strings', () => {
    const key = '/x/hooks.json:stop:0:0'
    writeFileSync(
      configPath,
      [
        `[hooks.state."${key}"]`,
        'note = """',
        'trusted_hash = "sha256:NOT-A-FIELD"',
        'enabled = false',
        '"""',
        ''
      ].join('\n'),
      'utf-8'
    )

    expect(readHookTrustEntries(configPath).get(key)).toEqual({
      trustedHash: undefined,
      enabled: undefined
    })
  })

  it('does not accept an unterminated trusted_hash string', () => {
    const key = '/x/hooks.json:stop:0:0'
    writeFileSync(
      configPath,
      `[hooks.state."${key}"]\ntrusted_hash = "sha256:UNTERMINATED\n`,
      'utf-8'
    )

    expect(readHookTrustEntries(configPath).get(key)?.trustedHash).toBeUndefined()
  })

  it('recognizes and removes a first trust block after a leading BOM', () => {
    const key = '/x/hooks.json:stop:0:0'
    const content = [
      `\uFEFF[hooks.state."${key}"]`,
      'trusted_hash = "sha256:ORCA"',
      '[other]',
      'value = true',
      ''
    ].join('\n')

    expect(readHookTrustEntriesFromContent(content).get(key)?.trustedHash).toBe('sha256:ORCA')
    expect(removeHookTrustEntriesFromContent(content, [key])).toBe('[other]\nvalue = true\n')
  })

  it('does not let triple quotes in comments hide later trust entries', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      '# user note mentions triple quote: """',
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:AAA"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)

    expect(result.get(key)).toEqual({ trustedHash: 'sha256:AAA', enabled: true })
  })

  it('does not let triple quotes in single-line strings hide later trust entries', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      'note = "\\"\\"\\""',
      'literal_note = \'"""\'',
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:AAA"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)

    expect(result.get(key)).toEqual({ trustedHash: 'sha256:AAA', enabled: true })
  })

  it('normalizes backslash block key to forward-slash at ingestion', () => {
    // Why: normalize the Map key (backslash -> forward-slash) so computeTrustKey lookups match either encoding.
    const original = [
      '[hooks.state."C:\\\\foo\\\\hooks.json:pre_tool_use:0:0"]',
      'enabled = true',
      'trusted_hash = "sha256:WIN"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.get('C:/foo/hooks.json:pre_tool_use:0:0')?.trustedHash).toBe('sha256:WIN')
  })

  it('reads a literal-string hook table key', () => {
    const rawKey = 'C:\\foo\\hooks.json:session_start:0:0'
    const original = [
      `[hooks.state.'${rawKey}']`,
      'enabled = false',
      'trusted_hash = "sha256:LITERAL"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.get('C:/foo/hooks.json:session_start:0:0')).toEqual({
      trustedHash: 'sha256:LITERAL',
      enabled: false
    })
  })

  it('supports case-insensitive lookups for Windows hook trust keys read from config', () => {
    // Why: Codex and realpathSync.native can disagree on path casing, but lookups must still match.
    const rawKey = 'C:\\Users\\rod\\AppData\\Roaming\\orca\\hooks.json:session_start:0:0'
    const lookupKey = 'C:/Users/Rod/AppData/Roaming/orca/hooks.json:session_start:0:0'
    const original = [
      `[hooks.state.'${rawKey}']`,
      'enabled = true',
      'trusted_hash = "sha256:CASE"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)

    expect(result.get(lookupKey)).toEqual({ trustedHash: 'sha256:CASE', enabled: true })
  })

  it('keeps POSIX-shaped hook trust paths case-sensitive', () => {
    const upperKey = '/windows/d/Repo/hooks.json:session_start:0:0'
    const lowerKey = '/windows/d/repo/hooks.json:session_start:0:0'
    writeFileSync(
      configPath,
      [
        `[hooks.state."${upperKey}"]`,
        'enabled = true',
        'trusted_hash = "sha256:UPPER"',
        '',
        `[hooks.state."${lowerKey}"]`,
        'enabled = true',
        'trusted_hash = "sha256:LOWER"',
        ''
      ].join('\n'),
      'utf-8'
    )

    const result = readHookTrustEntries(configPath)

    expect(result.get(upperKey)?.trustedHash).toBe('sha256:UPPER')
    expect(result.get(lowerKey)?.trustedHash).toBe('sha256:LOWER')
    expect(result.size).toBe(2)
  })

  it('keeps case-distinct WSL UNC hook paths distinct', () => {
    // Why: \\wsl$\<distro> is case-insensitive but the Linux tail is not — don't fold two distinct sources.
    const upperKey = '\\\\wsl$\\Ubuntu\\home\\u\\Repo\\hooks.json:session_start:0:0'
    const lowerKey = '\\\\wsl$\\Ubuntu\\home\\u\\repo\\hooks.json:session_start:0:0'
    writeFileSync(
      configPath,
      [
        `[hooks.state.'${upperKey}']`,
        'enabled = true',
        'trusted_hash = "sha256:UPPER"',
        '',
        `[hooks.state.'${lowerKey}']`,
        'enabled = true',
        'trusted_hash = "sha256:LOWER"',
        ''
      ].join('\n'),
      'utf-8'
    )

    const result = readHookTrustEntries(configPath)

    // Same share, different-cased distro/separators still fold to one key.
    expect(result.get('//WSL$/ubuntu/home/u/Repo/hooks.json:session_start:0:0')?.trustedHash).toBe(
      'sha256:UPPER'
    )
    expect(result.get(lowerKey)?.trustedHash).toBe('sha256:LOWER')
    expect(result.size).toBe(2)
  })

  it('reads entries from a CRLF-terminated config', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:CRLF"',
      ''
    ].join('\r\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.get(key)?.trustedHash).toBe('sha256:CRLF')
    expect(result.get(key)?.enabled).toBe(true)
  })

  it('keeps blocks that have no `trusted_hash` field so callers can see enabled-only state', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [`[hooks.state."${key}"]`, 'enabled = false', ''].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.size).toBe(1)
    expect(result.get(key)).toEqual({ trustedHash: undefined, enabled: false })
  })

  it('reads disabled state alongside a valid trusted hash', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      `[hooks.state."${key}"]`,
      'enabled = false',
      'trusted_hash = "sha256:DISABLED"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.get(key)).toEqual({ trustedHash: 'sha256:DISABLED', enabled: false })
  })

  it('does not extract a fake [hooks.state."<key>"] header from inside a """ block', () => {
    // Why: a header-shaped line inside a multi-line basic string must not parse as a real entry.
    const original = [
      'description = """',
      '[hooks.state."fake-key"]',
      'enabled = true',
      'trusted_hash = "sha256:FAKE"',
      '"""',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.size).toBe(0)
  })

  it("does not extract a fake [hooks.state.\"<key>\"] header from inside a ''' block", () => {
    // Why: same false-positive guard for multi-line literal strings.
    const original = [
      "description = '''",
      '[hooks.state."fake-key"]',
      'enabled = true',
      'trusted_hash = "sha256:FAKE"',
      "'''",
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.size).toBe(0)
  })

  it('reads a block whose header has an inline comment', () => {
    // Why: regression — headerLineRegex rejected TOML-valid trailing comments, hiding trust entries.
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = `[hooks.state."${key}"] # user note\nenabled = true\ntrusted_hash = "sha256:CMT"\n`
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.size).toBe(1)
    expect(result.get(key)?.trustedHash).toBe('sha256:CMT')
  })
})
