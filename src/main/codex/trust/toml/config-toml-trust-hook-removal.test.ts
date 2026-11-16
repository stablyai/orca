import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  readHookTrustEntries,
  removeHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { computeCodexTrustKey as computeTrustKey } from '../identity/codex-trust-identity'
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

describe('removeHookTrustEntries', () => {
  it.skipIf(process.platform === 'win32')('preserves restrictive config permissions', () => {
    const entry: CodexTrustEntry = {
      sourcePath: '/x/hooks.json',
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'echo trusted'
    }
    upsertHookTrustEntries(configPath, [entry])
    chmodSync(configPath, 0o600)

    removeHookTrustEntries(configPath, [computeTrustKey(entry)])

    expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')(
    'updates a symlink target without replacing config.toml',
    () => {
      const targetPath = join(tmpDir, 'dotfiles-config.toml')
      const entry: CodexTrustEntry = {
        sourcePath: '/x/hooks.json',
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'echo trusted'
      }
      upsertHookTrustEntries(targetPath, [entry])
      symlinkSync(targetPath, configPath)

      removeHookTrustEntries(configPath, [computeTrustKey(entry)])

      expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
      expect(readHookTrustEntries(targetPath).has(computeTrustKey(entry))).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')('does not replace a dangling config.toml symlink', () => {
    const targetPath = join(tmpDir, 'missing-dotfiles-config.toml')
    symlinkSync(targetPath, configPath)

    expect(() =>
      upsertHookTrustEntries(configPath, [
        {
          sourcePath: '/x/hooks.json',
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'echo trusted'
        }
      ])
    ).toThrow()

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(existsSync(targetPath)).toBe(false)
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
})
