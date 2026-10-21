import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { findDuplicateTomlDeclarations } from './config-toml-duplicate-declarations-test-fixture'
import {
  deduplicateProjectTomlSections,
  getProjectTrustLevel,
  getTomlSections
} from './config-toml-runtime-owned-sections'
import { upsertProjectTrustLevelInContent } from './config-toml-trust'

// Why (#22592): Codex's settings screen writes these spellings; each is the same TOML key as Orca's.
const PROJECT = '/Users/me/Projects/agentic-WPS'
const HEADER_SPELLINGS = [
  `["projects"."${PROJECT}"]`,
  `['projects'.'${PROJECT}']`,
  `[projects.'${PROJECT}']`,
  `[ "projects" . "${PROJECT}" ]  # trusted from the Codex TUI`
]

function upsertTrusted(content: string, projectPath = PROJECT): string {
  return upsertProjectTrustLevelInContent(content, projectPath, 'trusted', {
    alreadyCanonical: true
  })
}

describe('project trust writes recognise every spelling of the project table', () => {
  it.each(HEADER_SPELLINGS)('updates %s instead of appending a duplicate table', (header) => {
    const original = [header, 'trust_level = "untrusted"', ''].join('\n')

    const updated = upsertTrusted(original)

    expect(updated).toBe([header, 'trust_level = "trusted"', ''].join('\n'))
    expect(findDuplicateTomlDeclarations(updated)).toEqual([])
  })

  it.each(['"trust_level" = "untrusted"', "'trust_level' = 'untrusted'"])(
    'rewrites a quoted %s key instead of inserting a second one',
    (trustLine) => {
      const original = [`["projects"."${PROJECT}"]`, 'notes = "keep"', trustLine, ''].join('\n')

      const updated = upsertTrusted(original)

      expect(updated).toBe(
        [`["projects"."${PROJECT}"]`, 'notes = "keep"', 'trust_level = "trusted"', ''].join('\n')
      )
    }
  )

  it('leaves Codex quoted trust untouched in content when it is already trusted', () => {
    const original = [`["projects"."${PROJECT}"]`, '"trust_level" = "trusted"', ''].join('\n')

    const updated = upsertTrusted(original)

    expect(findDuplicateTomlDeclarations(updated)).toEqual([])
    expect(updated.match(/\[/g)).toHaveLength(1)
  })

  it('keeps CRLF line endings on the rewritten trust line', () => {
    const original = [`["projects"."${PROJECT}"]`, '"trust_level" = "untrusted"', ''].join('\r\n')

    expect(upsertTrusted(original)).toBe(
      [`["projects"."${PROJECT}"]`, 'trust_level = "trusted"', ''].join('\r\n')
    )
  })

  it.each([
    { header: "['projects'.'C:\\Users\\me\\repo']", projectPath: 'C:\\Users\\me\\repo' },
    { header: '["projects"."C:\\\\Users\\\\me\\\\repo"]', projectPath: 'C:\\Users\\me\\repo' },
    { header: '["projects"."c:/users/me/repo"]', projectPath: 'C:\\Users\\me\\repo' },
    {
      header: '["projects"."\\\\\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\me\\\\repo"]',
      projectPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    }
  ])('matches the Windows-path table $header', ({ header, projectPath }) => {
    const original = [header, '"trust_level" = "untrusted"', ''].join('\n')

    const updated = upsertTrusted(original, projectPath)

    expect(updated).toBe([header, 'trust_level = "trusted"', ''].join('\n'))
  })
})

describe('the config mirror treats every spelling as one project table', () => {
  it('reads a quoted trust_level key', () => {
    expect(getProjectTrustLevel(`["projects"."${PROJECT}"]\n"trust_level" = "untrusted"`)).toBe(
      'untrusted'
    )
  })

  it('deduplicates quoted, literal and bare spellings of one project', () => {
    const config = [
      `["projects"."${PROJECT}"]`,
      '"trust_level" = "trusted"',
      '',
      `['projects'.'${PROJECT}']`,
      "trust_level = 'trusted'",
      '',
      `[projects."${PROJECT}"]`,
      'trust_level = "trusted"',
      ''
    ].join('\n')

    const sections = deduplicateProjectTomlSections(getTomlSections(config))

    expect(sections.map((section) => section.header)).toEqual([`["projects"."${PROJECT}"]`])
  })

  describe('syncSystemConfigIntoManagedCodexHome', () => {
    let root: string
    let runtimeHomePath: string
    let systemHomePath: string

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'orca-project-spellings-'))
      runtimeHomePath = join(root, 'runtime')
      systemHomePath = join(root, 'system')
      mkdirSync(runtimeHomePath)
      mkdirSync(systemHomePath)
    })

    afterEach(() => rmSync(root, { recursive: true, force: true }))

    it('writes one table when the system and managed homes spell the project differently', () => {
      writeFileSync(
        join(systemHomePath, 'config.toml'),
        [
          'model = "gpt-5.5"',
          '',
          `["projects"."${PROJECT}"]`,
          '"trust_level" = "trusted"',
          ''
        ].join('\n')
      )
      writeFileSync(
        join(runtimeHomePath, 'config.toml'),
        [`[projects."${PROJECT}"]`, 'trust_level = "trusted"', ''].join('\n')
      )

      syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

      const runtimeConfig = readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')
      expect(runtimeConfig).toContain('model = "gpt-5.5"')
      expect(runtimeConfig.match(/projects/g)).toHaveLength(1)
      expect(findDuplicateTomlDeclarations(runtimeConfig)).toEqual([])
    })

    it('collapses a managed home already holding both spellings', () => {
      writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5.5"\n')
      writeFileSync(
        join(runtimeHomePath, 'config.toml'),
        [
          `["projects"."${PROJECT}"]`,
          '"trust_level" = "trusted"',
          '',
          `[projects."${PROJECT}"]`,
          'trust_level = "trusted"',
          ''
        ].join('\n')
      )

      syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

      const runtimeConfig = readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')
      expect(runtimeConfig.match(/projects/g)).toHaveLength(1)
      expect(findDuplicateTomlDeclarations(runtimeConfig)).toEqual([])
    })
  })
})
