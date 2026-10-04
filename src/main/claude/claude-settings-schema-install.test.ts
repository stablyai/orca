import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from './__fixtures__/claude-hook-event-enums.json'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import { ClaudeHookService } from './hook-service'

const enums: Record<string, string[]> = fixture.enums
const topLevelSettings: Record<string, { strict: boolean; keys: string[] }> =
  fixture.topLevelSettings
const strictReleases = Object.keys(topLevelSettings).filter(
  (version) => topLevelSettings[version].strict
)

// Why: checks the whole written file, so any new key Orca writes must pass each strict schema.
describe('Claude settings written for a strict settings schema', () => {
  let tmpHome: string
  let settingsPath: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-settings-schema-'))
    settingsPath = join(tmpHome, '.claude', 'settings.json')
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function expectAcceptedBy(version: string): void {
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const { keys } = topLevelSettings[version]
    expect(Object.keys(written).filter((key) => !keys.includes(key))).toEqual([])
    expect(
      Object.keys(written.hooks ?? {}).filter((event) => !enums[version].includes(event))
    ).toEqual([])
  }

  it.each(strictReleases)('a fresh install writes only what Claude %s accepts', (version) => {
    new ClaudeHookService().install({ claudeVersion: version })
    expectAcceptedBy(version)
  })

  it.each(strictReleases)('a downgrade to Claude %s leaves only what it accepts', (version) => {
    const service = new ClaudeHookService()
    service.install({ claudeVersion: '2.1.261' })
    service.install({ claudeVersion: version })
    expectAcceptedBy(version)
  })
})
