import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexHookSourcePath,
  parseTrustKey,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  createTrustConfigFixture,
  removeTrustConfigFixture
} from './config-toml-trust-test-fixtures'

let tmpDir: string

beforeEach(() => {
  tmpDir = createTrustConfigFixture().tmpDir
})

afterEach(() => {
  removeTrustConfigFixture(tmpDir)
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

  it('lexically normalizes source paths without resolving default-home aliases', () => {
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
    ).toBe(`${join(tmpDir, 'hooks.json')}:user_prompt_submit:0:0`)
  })

  // Why: ordinary Windows CI tokens cannot create file symlinks without Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'preserves a hooks.json leaf symlink in the trust key',
    () => {
      const hooksPath = join(tmpDir, 'hooks.json')
      const targetPath = join(tmpDir, 'dotfiles-hooks.json')
      writeFileSync(targetPath, '{"hooks":{}}\n', 'utf-8')
      symlinkSync(targetPath, hooksPath)

      expect(
        computeTrustKey({
          sourcePath: hooksPath,
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'irrelevant'
        })
      ).toBe(`${hooksPath}:stop:0:0`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'canonicalizes an existing POSIX path with two leading slashes',
    () => {
      const hooksPath = `/${join(tmpDir, 'hooks.json')}`
      writeFileSync(hooksPath, '{"hooks":{}}\n', 'utf-8')

      expect(normalizeCodexHookSourcePath(hooksPath)).toBe(join(tmpDir, 'hooks.json'))
    }
  )

  it('uses native Windows backslashes in the trust key Codex looks up', () => {
    // Why: Codex 0.140 writes approved Windows hook trust keys as raw native paths under [hooks.state].
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
    expect(normalizeCodexHookSourcePath('/tmp/with\\literal/hooks.json')).toBe(
      '/tmp/with\\literal/hooks.json'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'resolves an explicit home parent while preserving its hooks.json leaf symlink',
    () => {
      const logicalHome = join(tmpDir, 'logical-home')
      const targetHome = join(tmpDir, 'target-home')
      const targetHooks = join(tmpDir, 'target-hooks.json')
      mkdirSync(targetHome)
      writeFileSync(targetHooks, '{"hooks":{}}\n', 'utf-8')
      symlinkSync(targetHome, logicalHome)
      symlinkSync(targetHooks, join(targetHome, 'hooks.json'))

      expect(getCodexExplicitHomeHookSourcePath(join(logicalHome, 'hooks.json'))).toBe(
        join(realpathSync.native(targetHome), 'hooks.json')
      )
    }
  )
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
    // Why: anchor on the LAST three colons so colons inside sourcePath round-trip.
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

  // Why: Number('') === 0 passes Number.isInteger, so empty segments need explicit rejection.
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
