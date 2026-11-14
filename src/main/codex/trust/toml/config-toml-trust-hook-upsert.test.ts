import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeRegex } from '../../../../shared/string-utils'
import { upsertHookTrustEntries, type CodexTrustEntry } from './config-toml-trust'
import { escapeTomlBasicString as escapeTomlString } from '../../configuration/toml/config-toml-syntax'
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
    expect(written).toContain(`[hooks.state."${escapeTomlString(unrelatedKey)}"]`)
    expect(written).toContain('trusted_hash = "sha256:KEEP"')
    expect(written).toContain('enabled = false')
    expect(written).not.toContain('STALE1')
    expect(written).not.toContain('STALE2')
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
})
describe('upsertHookTrustEntries with array-of-tables boundaries', () => {
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

describe('upsertHookTrustEntries batch order', () => {
  const entry = (eventLabel: 'pre_tool_use' | 'stop', trustedHash: string): CodexTrustEntry => ({
    sourcePath: '/x/hooks.json',
    eventLabel,
    groupIndex: 0,
    handlerIndex: 0,
    command: 'echo',
    trustedHash
  })

  it('appends a missing entry before replacing the block that ended the file', () => {
    writeFileSync(
      configPath,
      '[hooks.state."/x/hooks.json:pre_tool_use:0:0"]\nenabled = true\ntrusted_hash = "OLD"\n',
      'utf-8'
    )

    upsertHookTrustEntries(configPath, [entry('stop', 'B'), entry('pre_tool_use', 'A')])

    expect(readFileSync(configPath, 'utf-8')).toBe(
      [
        '[hooks.state."/x/hooks.json:pre_tool_use:0:0"]',
        'enabled = true',
        'trusted_hash = "A"',
        '[hooks.state."/x/hooks.json:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "B"',
        ''
      ].join('\n')
    )
  })

  it('keeps text appended inside an unterminated multiline value owned by the open block', () => {
    writeFileSync(
      configPath,
      '[hooks.state."/x/hooks.json:pre_tool_use:0:0"]\nnote = """\n',
      'utf-8'
    )

    upsertHookTrustEntries(configPath, [
      { ...entry('stop', 'B'), enabled: false },
      entry('pre_tool_use', 'A')
    ])

    expect(readFileSync(configPath, 'utf-8')).toBe(
      '[hooks.state."/x/hooks.json:pre_tool_use:0:0"]\nenabled = false\ntrusted_hash = "A"\n'
    )
  })
})
