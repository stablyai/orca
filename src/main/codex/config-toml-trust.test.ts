/* eslint-disable max-lines -- Why: this suite keeps the hash fixture, TOML edit edge cases, and trust-state parser regressions together so Codex compatibility failures are easy to audit. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { escapeRegex } from '../../shared/string-utils'
import {
  computeTrustKey,
  computeTrustedHash,
  escapeTomlString,
  getCodexCanonicalTrustPath,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  upsertHookTrustEntries,
  upsertProjectTrustLevel,
  upsertProjectTrustLevelInContent,
  type CodexTrustEntry
} from './config-toml-trust'

// Why: this hash was captured from a real Codex 0.129 `/hooks` approval. If
// Codex changes its serialization or normalization rules, this test fails
// loudly instead of silently shipping bad trust entries that put hooks back
// into the review pile.
const REAL_APPROVED_COMMAND = '/bin/sh "/tmp/orca-case-b-mCmCe6/agent-hooks/codex-hook.sh"'
const REAL_APPROVED_HASH = 'sha256:bc013489dba495431d3790fda62ee5a7d907a7c491e29ad26238c3a5d6d2b163'

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orca-codex-trust-test-'))
  configPath = join(tmpDir, 'config.toml')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('computeTrustedHash', () => {
  it('reproduces the hash that Codex /hooks wrote for a real approval', () => {
    expect(
      computeTrustedHash({
        sourcePath: '/Users/thebr/.codex/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: REAL_APPROVED_COMMAND
      })
    ).toBe(REAL_APPROVED_HASH)
  })

  it('produces a different hash when the command changes', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'bar'
    })
    expect(a).not.toBe(b)
  })

  it('produces a different hash when the event label changes', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'post_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    expect(a).not.toBe(b)
  })

  it('ignores groupIndex/handlerIndex (those are part of the key, not the hash)', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 99,
      handlerIndex: 99,
      command: 'foo'
    })
    expect(a).toBe(b)
  })

  it('hashes a missing matcher the same as no matcher field', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      matcher: undefined
    })
    expect(a).toBe(b)
  })

  it('produces a different hash when matcher is set', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      matcher: 'foo'
    })
    expect(a).not.toBe(b)
  })

  it('drops the matcher on user_prompt_submit/stop like matcher_pattern_for_event', () => {
    // Why: Codex ignores matchers on these two events and hashes the
    // identity WITHOUT the matcher field. A definition carrying
    // `"matcher": ""` (common in third-party installers) must therefore
    // hash identically to one without a matcher, or the system-trust
    // mirror misses and the stale-entry sweep deletes the trust Codex
    // wrote — re-prompting the user on every launch.
    for (const eventLabel of ['user_prompt_submit', 'stop'] as const) {
      const base: CodexTrustEntry = {
        sourcePath: '/x/hooks.json',
        eventLabel,
        groupIndex: 0,
        handlerIndex: 0,
        command: 'foo'
      }
      const bare = computeTrustedHash(base)
      expect(computeTrustedHash({ ...base, matcher: '' })).toBe(bare)
      expect(computeTrustedHash({ ...base, matcher: 'anything' })).toBe(bare)
    }
  })

  it('pins the matcher-omitted hash for a Stop entry that carries an empty matcher', () => {
    // Why: regression pin for the shape observed in the wild (a real
    // Codex 0.140 config.toml, path anonymized): Codex stores the
    // matcher-omitted hash for Stop even when hooks.json carries
    // `"matcher": ""`, so we must never fold the matcher into this
    // identity. If serialization or normalization drifts, this constant
    // fails loudly.
    expect(
      computeTrustedHash({
        sourcePath: '/home/user/.codex/hooks.json',
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: '/home/user/.tma1/hooks/agent-hook.sh',
        matcher: ''
      })
    ).toBe('sha256:f8b48c31eabfba63f117b8570b839a5f6efc1d67867512d661775b5312df946f')
  })

  it('produces a different hash when statusMessage is set', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      statusMessage: 'msg'
    })
    expect(a).not.toBe(b)
  })

  it('produces a different hash when async flips from default false to true', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      async: false
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      async: true
    })
    expect(a).not.toBe(b)
  })

  it('clamps timeoutSec=0 to 1 (which differs from the unset default of 600)', () => {
    const zero = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      timeoutSec: 0
    })
    const one = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      timeoutSec: 1
    })
    const unset = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    expect(zero).toBe(one)
    expect(zero).not.toBe(unset)
  })
})

describe('computeTrustKey', () => {
  it('joins source path, event label, group index, handler index with colons', () => {
    expect(
      computeTrustKey({
        sourcePath: '/Users/thebr/.codex/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'irrelevant'
      })
    ).toBe('/Users/thebr/.codex/hooks.json:pre_tool_use:0:0')
  })

  it('uses Codex canonicalized source paths when hooks.json exists', () => {
    const nestedDir = join(tmpDir, 'nested')
    mkdirSync(nestedDir)
    const hooksPath = join(nestedDir, '..', 'hooks.json')
    writeFileSync(hooksPath, '{"hooks":{}}\n', 'utf-8')

    expect(
      computeTrustKey({
        sourcePath: hooksPath,
        eventLabel: 'user_prompt_submit',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'irrelevant'
      })
    ).toBe(`${realpathSync.native(hooksPath)}:user_prompt_submit:0:0`)
  })

  it('uses native Windows backslashes in the trust key Codex looks up', () => {
    // Why: Codex 0.140 writes approved Windows hook trust keys as raw native
    // paths under [hooks.state].
    const winPath = 'C:\\Users\\Rod\\AppData\\Roaming\\orca\\hooks.json'
    const key = computeTrustKey({
      sourcePath: winPath,
      eventLabel: 'session_start',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo'
    })
    expect(key).toContain('\\')
    expect(key.startsWith('C:\\Users\\Rod\\AppData\\Roaming\\orca\\hooks.json:')).toBe(true)
  })

  it('preserves literal backslashes in non-Windows-style fallback paths', () => {
    // Why: SSH/POSIX paths can legally contain `\` as a filename character;
    // only Windows-style separators should be normalized.
    expect(getCodexCanonicalTrustPath('/tmp/with\\literal/hooks.json')).toBe(
      '/tmp/with\\literal/hooks.json'
    )
  })
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
    // Why: we only own the [hooks.state."<key>"] block — the [features]
    // block must be unchanged.
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
    // Why: a no-op upsert must not roll the .bak forward — repeated calls
    // (e.g. from app start) would otherwise destroy the last recoverable copy.
    rmSync(`${configPath}.bak`, { force: true })
    upsertHookTrustEntries(configPath, [entry])
    expect(existsSync(`${configPath}.bak`)).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).toBe(firstWrite)
  })

  it('replaces a stale block written with CRLF line endings without duplicating', () => {
    // Why: regression — Windows-style \r\n in the existing config previously
    // caused the header pattern to miss and append a duplicate block.
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

  // Why: TOML supports both basic-string and literal-string quoted keys;
  // header detection must respect `]` inside `'...'` too.
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
    // Why: a basic multi-line string with `\"` escapes must not be misread as
    // closing early — content and any following real header must survive intact.
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
    // Why: a backslash in a POSIX path can be a literal filename character, so
    // it must still be escaped instead of normalized away.
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
    // Why: regression — buildHeaderPattern used to require column-0 headers,
    // but the reader accepts indented ones. That mismatch caused upsert to
    // append a duplicate `[hooks.state."<key>"]` block, producing invalid TOML.
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
    // Why: regression — auto-install on app start used to clobber a
    // hand-disabled hook back to enabled = true, removing the only way to
    // mute Orca's hook short of full uninstall.
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
    // Why: regression — buildHeaderPattern used to require a trailing
    // `\r?\n`, missing it caused the upsert path to take the no-match branch
    // and append a duplicate block at EOF.
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
    // Why: regression — buildHeaderPattern used to require the header line
    // to end at \r?\n or EOF, missing TOML-valid trailing comments. The
    // upsert path then took the no-match branch and appended a duplicate
    // `[hooks.state."<key>"]` block, producing invalid TOML.
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
    // Why: Codex 0.140 can expose Windows trust keys with either separator
    // shape depending on startup cwd, so Orca replaces stale blocks with both.
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
    // Why: idempotency guard — repeated auto-install on app start must not
    // accumulate duplicate trust blocks and produce invalid TOML.
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
    // Why: TOML literal-string table keys cannot contain apostrophes, but
    // Windows user/profile paths can.
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

  it.skipIf(process.platform !== 'win32')(
    'finds a Codex-written block with lowercased username when Orca key has mixed-case username',
    () => {
      // Why: realpathSync.native casing can differ between what Codex wrote
      // (C:\Users\rod\...) and what Orca resolves (C:\Users\Rod\...).
      // normalizeHookTrustKeyForLookup case-folds on Windows so the existing block is
      // replaced rather than a duplicate appended.
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
    }
  )
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
    // Why: local project trust still follows Codex's realpath display, while
    // remote project trust preserves the SSH provider's canonical path string.
    const original = ['[profiles.default]', 'model = "gpt-5"', ''].join('\r\n')

    const updated = upsertProjectTrustLevelInContent(original, 'C:\\Users\\nw\\repo', 'trusted')

    expect(updated).toContain(
      ['[projects."C:\\\\Users\\\\nw\\\\repo"]', 'trust_level = "trusted"', ''].join('\r\n')
    )
    expect(updated).toContain('[profiles.default]\r\nmodel = "gpt-5"')
  })

  it('updates an existing Windows backslash project block after separator normalization', () => {
    // Why: hook trust now writes paired Windows variants, but project trust
    // must still repair an existing single project table in place.
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
    // Why: older Orca builds normalized Windows project paths to forward
    // slashes; native-backslash hook fixes must not duplicate those blocks.
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
    // Why: SSH project paths are resolved on the remote; local realpath would
    // canonicalize the wrong machine if the same path happens to exist locally.
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

describe('removeHookTrustEntries', () => {
  it('is a no-op (creates no file) when the config does not exist', () => {
    removeHookTrustEntries(configPath, ['/x/hooks.json:pre_tool_use:0:0'])
    expect(existsSync(configPath)).toBe(false)
  })

  it('does not roll a .bak forward when the requested key is not present', () => {
    const original = ['[features]', 'hooks = true', ''].join('\n')
    writeFileSync(configPath, original, 'utf-8')
    removeHookTrustEntries(configPath, ['/missing/hooks.json:pre_tool_use:0:0'])
    expect(readFileSync(configPath, 'utf-8')).toBe(original)
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })

  it('removes a single block while leaving unrelated tables intact', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      '[features]',
      'hooks = true',
      '',
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:KEEP"',
      '',
      '[unrelated]',
      'value = 42',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    removeHookTrustEntries(configPath, [key])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain(`[hooks.state."${key}"]`)
    expect(written).not.toContain('sha256:KEEP')
    expect(written).toContain('[features]\nhooks = true')
    expect(written).toContain('[unrelated]\nvalue = 42')
  })

  it('removes duplicate blocks for the requested key', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const otherKey = '/x/hooks.json:post_tool_use:0:0'
    const original = [
      `[hooks.state."${key}"]`,
      'enabled = false',
      'trusted_hash = "sha256:A"',
      '',
      `[hooks.state."${otherKey}"]`,
      'enabled = true',
      'trusted_hash = "sha256:OTHER"',
      '',
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:B"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    removeHookTrustEntries(configPath, [key])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain(`[hooks.state."${key}"]`)
    expect(written).not.toContain('sha256:A')
    expect(written).not.toContain('sha256:B')
    expect(written).toContain(`[hooks.state."${otherKey}"]`)
    expect(written).toContain('sha256:OTHER')
  })

  it('removes a literal-string hook table for the requested key', () => {
    const key = 'C:\\x\\hooks.json:session_start:0:0'
    const original = [
      `[hooks.state.'${key}']`,
      'enabled = true',
      'trusted_hash = "sha256:LITERAL"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    removeHookTrustEntries(configPath, [key])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain(`[hooks.state.'${key}']`)
    expect(written).not.toContain('sha256:LITERAL')
  })

  it('removes mixed quoting duplicates for the requested key', () => {
    const key = 'C:\\x\\hooks.json:session_start:0:0'
    const original = [
      `[hooks.state.'${key}']`,
      'enabled = true',
      'trusted_hash = "sha256:LITERAL"',
      '',
      `[hooks.state."${escapeTomlString(key)}"]`,
      'enabled = true',
      'trusted_hash = "sha256:BASIC"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    removeHookTrustEntries(configPath, [key])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain(`[hooks.state.'${key}']`)
    expect(written).not.toContain(`[hooks.state."${escapeTomlString(key)}"]`)
  })

  it('does not remove the target hook header text inside a multi-line string', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:K"',
      '',
      '[notes]',
      'body = """',
      `[hooks.state."${key}"]`,
      'is only documentation here.',
      '"""',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    removeHookTrustEntries(configPath, [key])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain('sha256:K')
    expect(written).toContain('[notes]')
    expect(written).toContain(
      ['body = """', `[hooks.state."${key}"]`, 'is only documentation here.', '"""'].join('\n')
    )
  })

  it('does not let triple quotes in comments hide a block being removed', () => {
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      '# user note mentions triple quote: """',
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:K"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    removeHookTrustEntries(configPath, [key])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('# user note mentions triple quote: """')
    expect(written).not.toContain(`[hooks.state."${key}"]`)
    expect(written).not.toContain('sha256:K')
  })

  it('preserves the line separator when no blank line precedes the removed block', () => {
    // Why: regression — removeTrustBlock used to cut from match.index (the
    // captured leading newline) and fused the previous content into the next
    // header, producing invalid TOML like `a = 1[other]`.
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = [
      'a = 1',
      `[hooks.state."${key}"]`,
      'enabled = true',
      'trusted_hash = "sha256:K"',
      '[other]',
      'b = 2',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    removeHookTrustEntries(configPath, [key])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain('a = 1[other]')
    expect(written).toContain('a = 1\n[other]')
  })

  it('removes multiple blocks in a single call', () => {
    const keyA = '/x/hooks.json:pre_tool_use:0:0'
    const keyB = '/x/hooks.json:post_tool_use:0:0'
    const original = [
      `[hooks.state."${keyA}"]`,
      'enabled = true',
      'trusted_hash = "sha256:A"',
      '',
      `[hooks.state."${keyB}"]`,
      'enabled = true',
      'trusted_hash = "sha256:B"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    removeHookTrustEntries(configPath, [keyA, keyB])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain(`[hooks.state."${keyA}"]`)
    expect(written).not.toContain(`[hooks.state."${keyB}"]`)
    expect(written).not.toContain('sha256:A')
    expect(written).not.toContain('sha256:B')
  })

  it('removes a block whose header has an inline comment', () => {
    // Why: paired with the upsert regression; the same pattern mismatch
    // would silently leave the dead block in place during uninstall.
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = `[hooks.state."${key}"] # user note\nenabled = true\ntrusted_hash = "sha256:K"\n`
    writeFileSync(configPath, original, 'utf-8')

    removeHookTrustEntries(configPath, [key])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain(`[hooks.state."${key}"]`)
  })
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
    // Why: a real Windows path on disk like C:\foo gets written escaped as
    // `C:\\foo` inside the TOML key. The Map key is normalized (backslash ->
    // forward-slash) so computeTrustKey lookups match regardless of how Codex
    // encoded the path separator.
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

  it.skipIf(process.platform !== 'win32')(
    'supports case-insensitive lookups for Windows hook trust keys read from config',
    () => {
      // Why: Codex and realpathSync.native can disagree on user-path casing;
      // status checks still need Map.get(computeTrustKey(...)) to find the row.
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
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'keeps WSL hook trust paths case-sensitive on a Windows host',
    () => {
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
    }
  )

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
    // Why: a header-shaped line embedded in a multi-line basic string must not
    // be parsed as a real trust entry.
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
    // Why: regression — headerLineRegex used to reject TOML-valid trailing
    // comments, hiding existing trust entries from getStatus and causing
    // it to misreport hooks as untrusted.
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = `[hooks.state."${key}"] # user note\nenabled = true\ntrusted_hash = "sha256:CMT"\n`
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.size).toBe(1)
    expect(result.get(key)?.trustedHash).toBe('sha256:CMT')
  })
})

describe('parseTrustKey', () => {
  it('parses a typical posix-style key', () => {
    expect(parseTrustKey('/Users/x/.codex/hooks.json:pre_tool_use:0:0')).toEqual({
      sourcePath: '/Users/x/.codex/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0
    })
  })

  it('parses a Windows-style sourcePath whose drive letter contains a colon', () => {
    // Why: validates the "anchor on the LAST three colons" approach so colons
    // inside the sourcePath itself round-trip correctly.
    expect(parseTrustKey('C:\\Users\\x\\.codex\\hooks.json:session_start:2:3')).toEqual({
      sourcePath: 'C:\\Users\\x\\.codex\\hooks.json',
      eventLabel: 'session_start',
      groupIndex: 2,
      handlerIndex: 3
    })
  })

  it('returns null for a non-Codex event label', () => {
    expect(parseTrustKey('/x/hooks.json:not_an_event:0:0')).toBeNull()
  })

  it('returns null for a key with too few colons', () => {
    expect(parseTrustKey('foo:bar')).toBeNull()
    expect(parseTrustKey('foo')).toBeNull()
  })

  it('returns null when the group index is not an integer', () => {
    expect(parseTrustKey('/x/hooks.json:pre_tool_use:abc:0')).toBeNull()
  })

  it('returns null when the handler index is not an integer', () => {
    expect(parseTrustKey('/x/hooks.json:pre_tool_use:0:abc')).toBeNull()
  })

  it('returns null when the source path is empty', () => {
    expect(parseTrustKey(':pre_tool_use:0:0')).toBeNull()
  })

  it('round-trips with computeTrustKey', () => {
    const entry: CodexTrustEntry = {
      sourcePath: '/Users/x/.codex/hooks.json',
      eventLabel: 'post_tool_use',
      groupIndex: 4,
      handlerIndex: 7,
      command: 'irrelevant'
    }
    const parsed = parseTrustKey(computeTrustKey(entry))
    expect(parsed).toEqual({
      sourcePath: entry.sourcePath,
      eventLabel: entry.eventLabel,
      groupIndex: entry.groupIndex,
      handlerIndex: entry.handlerIndex
    })
  })

  // Why: Number('') === 0 silently passes Number.isInteger; without strict
  // canonical-form validation, malformed keys would coerce into valid ones.
  it('returns null for empty group/handler segments', () => {
    expect(parseTrustKey('/x/hooks.json:pre_tool_use::0')).toBeNull()
    expect(parseTrustKey('/x/hooks.json:pre_tool_use:0:')).toBeNull()
    expect(parseTrustKey('/x/hooks.json:pre_tool_use::')).toBeNull()
  })

  it('returns null for exponent or whitespace numeric segments', () => {
    expect(parseTrustKey('/x/hooks.json:pre_tool_use:1e2:0')).toBeNull()
    expect(parseTrustKey('/x/hooks.json:pre_tool_use: 0:0')).toBeNull()
    expect(parseTrustKey('/x/hooks.json:pre_tool_use:01:0')).toBeNull()
  })
})

describe('upsertHookTrustEntries with array-of-tables boundaries', () => {
  // Why: findNextTableHeader must treat `[[array.of.tables]]` as a block
  // boundary; otherwise an upsert/remove can consume past array entries
  // into unrelated user content.
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
