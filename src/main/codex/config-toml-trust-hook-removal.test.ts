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
  computeTrustKey,
  escapeTomlString,
  readHookTrustEntries,
  removeHookTrustEntries,
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
    // Why: regression — removeTrustBlock cut the leading newline, fusing prior content into the next header.
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
    // Why: same pattern mismatch as the upsert regression would leave the dead block during uninstall.
    const key = '/x/hooks.json:pre_tool_use:0:0'
    const original = `[hooks.state."${key}"] # user note\nenabled = true\ntrusted_hash = "sha256:K"\n`
    writeFileSync(configPath, original, 'utf-8')

    removeHookTrustEntries(configPath, [key])

    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain(`[hooks.state."${key}"]`)
  })
})
