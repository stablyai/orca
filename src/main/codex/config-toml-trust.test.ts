/* eslint-disable max-lines -- Why: this suite keeps the hash fixture, TOML edit edge cases, and trust-state parser regressions together so Codex compatibility failures are easy to audit. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  computeTrustKey,
  computeTrustedHash,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  upsertHookTrustEntries,
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

  it('escapes literal `"` and `\\` in the source path inside the trust block header', () => {
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

  it('unescapes `\\\\` in the block key', () => {
    // Why: a real Windows path on disk like C:\foo gets written escaped as
    // `C:\\foo` inside the TOML key — the returned Map should expose the
    // original unescaped form.
    const original = [
      '[hooks.state."C:\\\\foo\\\\hooks.json:pre_tool_use:0:0"]',
      'enabled = true',
      'trusted_hash = "sha256:WIN"',
      ''
    ].join('\n')
    writeFileSync(configPath, original, 'utf-8')

    const result = readHookTrustEntries(configPath)
    expect(result.get('C:\\foo\\hooks.json:pre_tool_use:0:0')?.trustedHash).toBe('sha256:WIN')
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
