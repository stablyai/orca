import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexHookSourcePath,
  parseTrustKey
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

  // Windows CI requires Developer Mode for file symlinks.
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
  it('parses a Windows-style sourcePath whose drive letter contains a colon', () => {
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
