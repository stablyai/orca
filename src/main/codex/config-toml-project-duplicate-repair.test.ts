import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { findDuplicateTomlDeclarations } from './config-toml-duplicate-declarations-test-fixture'
import { repairOrcaDuplicateTrustTables } from './config-toml-project-duplicate-repair'
import { upsertProjectTrustLevel, upsertProjectTrustLevelInContent } from './config-toml-trust'
import {
  createTrustConfigFixture,
  removeTrustConfigFixture
} from './config-toml-trust-test-fixtures'

// Why: each case uses its own path because refusals are logged once per process.
let tmpDir: string
let configPath: string
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  const fixture = createTrustConfigFixture()
  tmpDir = fixture.tmpDir
  configPath = fixture.configPath
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  removeTrustConfigFixture(tmpDir)
})

describe('repairing configs broken by #22592', () => {
  it('removes the table Orca appended beside Codex quoted spelling and keeps a .bak', () => {
    const projectPath = '/Users/me/Projects/agentic-WPS'
    // The reported file: Codex's table, then the duplicate an older Orca appended.
    const broken = [
      'model = "gpt-5.5"',
      '',
      `["projects"."${projectPath}"]`,
      '"trust_level" = "trusted"',
      '',
      `[projects."${projectPath}"]`,
      'trust_level = "trusted"',
      ''
    ].join('\n')
    writeFileSync(configPath, broken)
    expect(findDuplicateTomlDeclarations(broken)).not.toEqual([])

    upsertProjectTrustLevel(configPath, projectPath, 'trusted')

    const repaired = readFileSync(configPath, 'utf-8')
    expect(repaired).toBe(
      [
        'model = "gpt-5.5"',
        '',
        `["projects"."${projectPath}"]`,
        'trust_level = "trusted"',
        ''
      ].join('\n')
    )
    expect(findDuplicateTomlDeclarations(repaired)).toEqual([])
    expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(broken)
    expect(warn).not.toHaveBeenCalled()
  })

  it('repairs a duplicate for another project than the one being trusted', () => {
    const broken = [
      "['projects'.'/repo-a']",
      'trust_level = "untrusted"',
      'notes = "user"',
      '',
      '[projects."/repo-a"]',
      'trust_level = "trusted"',
      ''
    ].join('\n')

    const updated = upsertProjectTrustLevelInContent(broken, '/repo-b', 'trusted', {
      alreadyCanonical: true
    })

    expect(updated).toBe(
      [
        "['projects'.'/repo-a']",
        'trust_level = "untrusted"',
        'notes = "user"',
        '',
        '[projects."/repo-b"]',
        'trust_level = "trusted"',
        ''
      ].join('\n')
    )
  })

  it('removes the bare trust_level line Orca inserted under a quoted key', () => {
    const broken = [
      '["projects"."/repo-c"]',
      'trust_level = "trusted"',
      '"trust_level" = "trusted"',
      ''
    ].join('\r\n')

    const repaired = repairOrcaDuplicateTrustTables(broken)

    expect(repaired).toBe(['["projects"."/repo-c"]', '"trust_level" = "trusted"', ''].join('\r\n'))
  })

  it('repairs Windows-path tables that decode to the same key', () => {
    const broken = [
      "['projects'.'C:\\Users\\me\\repo']",
      "trust_level = 'trusted'",
      '',
      '[projects."C:\\\\Users\\\\me\\\\repo"]',
      'trust_level = "trusted"',
      ''
    ].join('\n')

    const repaired = repairOrcaDuplicateTrustTables(broken)

    expect(repaired).toBe(
      ["['projects'.'C:\\Users\\me\\repo']", "trust_level = 'trusted'", ''].join('\n')
    )
  })

  it('keeps Windows slash variants, which are distinct TOML keys', () => {
    const config = [
      "['projects'.'C:\\Users\\me\\slashes']",
      'trust_level = "trusted"',
      '',
      '[projects."C:/Users/me/slashes"]',
      'trust_level = "trusted"',
      ''
    ].join('\n')

    expect(repairOrcaDuplicateTrustTables(config)).toBe(config)
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves a user-authored duplicate alone and logs it once', () => {
    const broken = [
      '["projects"."/repo-d"]',
      'trust_level = "trusted"',
      '',
      '[projects."/repo-d"]',
      'trust_level = "trusted"',
      'notes = "hand-written"',
      ''
    ].join('\n')

    const first = upsertProjectTrustLevelInContent(broken, '/repo-d', 'trusted', {
      alreadyCanonical: true
    })
    const second = upsertProjectTrustLevelInContent(broken, '/repo-d', 'trusted', {
      alreadyCanonical: true
    })

    expect(first).toBe(broken)
    expect(second).toBe(broken)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('leaves the file untouched when another duplicate would still break it', () => {
    const broken = [
      '["projects"."/repo-e"]',
      'trust_level = "trusted"',
      '',
      '[profiles.fast]',
      'model = "a"',
      '',
      '["profiles"."fast"]',
      'model = "b"',
      '',
      '[projects."/repo-e"]',
      'trust_level = "trusted"',
      ''
    ].join('\n')

    expect(repairOrcaDuplicateTrustTables(broken)).toBe(broken)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not touch a valid config', () => {
    const config = ['["projects"."/repo-f"]', '"trust_level" = "trusted"', ''].join('\n')

    expect(repairOrcaDuplicateTrustTables(config)).toBe(config)
    expect(warn).not.toHaveBeenCalled()
  })
})
