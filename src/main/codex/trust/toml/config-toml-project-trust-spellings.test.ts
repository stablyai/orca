import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncSystemConfigIntoManagedCodexHome } from '../../configuration/settings/codex-config-mirror'
import { findDuplicateTomlDeclarations } from '../../configuration/toml/config-toml-duplicate-declarations-test-fixture'

import './config-toml-trust'
import { upsertProjectTrustContent as upsertProjectTrustLevelInContent } from './config-toml-project-trust'

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

  it.each([
    {
      label: 'a literal string ending in four quotes',
      argsLine: `args = ["-c", '''printf 'ok'''']`
    },
    {
      label: 'a basic string ending in four quotes',
      argsLine: `args = ["-c", """printf "ok""""]`
    }
  ])('updates the project table after $label', ({ argsLine }) => {
    const project = '/tmp/orca-toml-repro'
    const original = [
      '[mcp_servers.repro]',
      'command = "sh"',
      argsLine,
      '',
      `[projects."${project}"]`,
      'trust_level = "untrusted"',
      ''
    ].join('\n')

    const updated = upsertTrusted(original, project)

    expect(updated).toBe(
      [
        '[mcp_servers.repro]',
        'command = "sh"',
        argsLine,
        '',
        `[projects."${project}"]`,
        'trust_level = "trusted"',
        ''
      ].join('\n')
    )
  })
})

describe('the config mirror treats every spelling as one project table', () => {
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
  })
})
