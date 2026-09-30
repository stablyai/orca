import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { findDuplicateTomlDeclarations } from './config-toml-duplicate-declarations-test-fixture'
import { repairOrcaDuplicateTrustTables } from './config-toml-project-duplicate-repair'
import {
  upsertHookTrustEntriesInContent,
  upsertProjectTrustLevel,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  createTrustConfigFixture,
  removeTrustConfigFixture
} from './config-toml-trust-test-fixtures'

// Why (#22592): Codex's writer spells hook trust as ["hooks"."state"."<key>"].
const HOOK_KEY = '/Users/me/.codex/hooks.json:stop:0:0'
const hookEntry: CodexTrustEntry = {
  sourcePath: '/Users/me/.codex/hooks.json',
  eventLabel: 'stop',
  groupIndex: 0,
  handlerIndex: 0,
  command: 'orca-hook',
  trustedHash: 'sha256:new'
}

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

describe('hook trust recognises Codex quoted hooks.state spellings', () => {
  it('rewrites a quoted hook table instead of appending a bare copy', () => {
    const original = [
      `["hooks"."state"."${HOOK_KEY}"]`,
      'enabled = true',
      'trusted_hash = "sha256:old"',
      ''
    ].join('\n')

    const updated = upsertHookTrustEntriesInContent(original, [hookEntry])

    expect(updated).toBe(
      [`[hooks.state."${HOOK_KEY}"]`, 'enabled = true', 'trusted_hash = "sha256:new"', ''].join(
        '\n'
      )
    )
  })

  it('does not add a bare parent table beside a quoted one for Windows hooks', () => {
    const windowsEntry = { ...hookEntry, sourcePath: 'C:\\Users\\me\\.codex\\hooks.json' }
    const original = ['["hooks"."state"]', ''].join('\n')

    const updated = upsertHookTrustEntriesInContent(original, [windowsEntry])

    expect(updated.startsWith('["hooks"."state"]\n')).toBe(true)
    expect(updated).not.toContain('[hooks.state]')
    expect(findDuplicateTomlDeclarations(updated)).toEqual([])
  })

  it('treats a quoted hook table as runtime-owned trust in the config mirror', () => {
    const runtimeHomePath = join(tmpDir, 'runtime')
    const systemHomePath = join(tmpDir, 'system')
    mkdirSync(runtimeHomePath)
    mkdirSync(systemHomePath)
    writeFileSync(
      join(systemHomePath, 'config.toml'),
      ['model = "gpt-5.5"', '', '["hooks"."state"]', '', `["hooks"."state"."${HOOK_KEY}"]`]
        .concat(['enabled = true', 'trusted_hash = "sha256:system"', ''])
        .join('\n')
    )
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      ['[hooks.state]', '', `[hooks.state."${HOOK_KEY}"]`]
        .concat(['enabled = true', 'trusted_hash = "sha256:runtime"', ''])
        .join('\n')
    )

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

    const runtimeConfig = readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')
    expect(runtimeConfig).toContain('trusted_hash = "sha256:runtime"')
    expect(runtimeConfig).not.toContain('"hooks"')
    expect(findDuplicateTomlDeclarations(runtimeConfig)).toEqual([])
  })
})

describe('repairing Orca hooks.state duplicates', () => {
  it('fully repairs a file holding both project and hook duplicates', () => {
    const projectPath = '/Users/me/Projects/agentic-WPS'
    const broken = [
      'model = "gpt-5.5"',
      '',
      `["projects"."${projectPath}"]`,
      '"trust_level" = "trusted"',
      '',
      '["hooks"."state"]',
      '',
      `["hooks"."state"."${HOOK_KEY}"]`,
      'enabled = false',
      'trusted_hash = "sha256:user"',
      '',
      `[projects."${projectPath}"]`,
      'trust_level = "trusted"',
      '',
      '[hooks.state]',
      '',
      `[hooks.state."${HOOK_KEY}"]`,
      'enabled = true',
      'trusted_hash = "sha256:orca"',
      ''
    ].join('\n')
    writeFileSync(configPath, broken)

    upsertProjectTrustLevel(configPath, projectPath, 'trusted')

    const repaired = readFileSync(configPath, 'utf-8')
    expect(repaired).toBe(
      [
        'model = "gpt-5.5"',
        '',
        `["projects"."${projectPath}"]`,
        'trust_level = "trusted"',
        '',
        '["hooks"."state"]',
        '',
        `["hooks"."state"."${HOOK_KEY}"]`,
        'enabled = false',
        'trusted_hash = "sha256:user"',
        ''
      ].join('\n')
    )
    expect(findDuplicateTomlDeclarations(repaired)).toEqual([])
    expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(broken)
    expect(warn).not.toHaveBeenCalled()
  })

  it('removes the Orca-shaped copy when it comes before the user table', () => {
    const broken = [
      '[projects."/orca-first"]',
      'trust_level = "trusted"',
      '',
      `[hooks.state.'C:\\Users\\me\\.codex\\hooks.json:stop:0:0']`,
      'enabled = true',
      'trusted_hash = "sha256:orca"',
      '',
      '["projects"."/orca-first"]',
      'trust_level = "untrusted"',
      '',
      '["hooks"."state"."C:\\\\Users\\\\me\\\\.codex\\\\hooks.json:stop:0:0"]',
      'enabled = false',
      'trusted_hash = "sha256:user"',
      ''
    ].join('\n')

    expect(repairOrcaDuplicateTrustTables(broken)).toBe(
      [
        '["projects"."/orca-first"]',
        'trust_level = "untrusted"',
        '',
        '["hooks"."state"."C:\\\\Users\\\\me\\\\.codex\\\\hooks.json:stop:0:0"]',
        'enabled = false',
        'trusted_hash = "sha256:user"',
        ''
      ].join('\n')
    )
  })

  it('leaves two user-shaped hook tables alone and logs once', () => {
    const broken = [
      '["hooks"."state"."/two-users:stop:0:0"]',
      'enabled = true',
      '',
      '[hooks.state."/two-users:stop:0:0"]',
      'enabled = true',
      'trusted_hash = "sha256:a"',
      'note = "hand-written"',
      ''
    ].join('\n')

    expect(repairOrcaDuplicateTrustTables(broken)).toBe(broken)
    expect(repairOrcaDuplicateTrustTables(broken)).toBe(broken)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
