import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { readHooksJson } from '../agent-hooks/installer-utils'
import { OPENCLAUDE_HOOK_SETTINGS } from './hook-settings'

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

  it('adds elicitation hooks at 2.1.63 and removes them on a 2.1.62 downgrade', () => {
    const service = new ClaudeHookService()
    service.install({ claudeVersion: '2.1.62' })
    const old = readHooksJson(settingsPath)
    expect(old?.hooks?.Elicitation).toBeUndefined()
    expect(old?.hooks?.ElicitationResult).toBeUndefined()
    expect(service.getStatus({ claudeVersion: '2.1.63' }).state).toBe('partial')

    expect(service.install({ claudeVersion: '2.1.63' }).state).toBe('installed')
    const upgraded = readHooksJson(settingsPath)
    for (const event of ['Elicitation', 'ElicitationResult']) {
      expect(upgraded?.hooks?.[event]).toEqual([
        { matcher: '*', hooks: [expect.objectContaining({ type: 'command' })] }
      ])
    }
    service.install({ claudeVersion: '2.1.62' })
    expect(readHooksJson(settingsPath)).toEqual(old)
  })

  it('preserves user elicitation hooks on downgrade and retains managed hooks on an unresolved version', () => {
    const userHook = { hooks: [{ type: 'command', command: 'echo my-elicitation' }] }
    const user = {
      env: { MY_SETTING: 'retained' },
      hooks: { Elicitation: [userHook], ElicitationResult: [userHook] }
    }
    mkdirSync(join(tmpHome, '.claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(user))
    const service = new ClaudeHookService()
    service.install({ claudeVersion: '2.1.63' })
    const upgraded = readFileSync(settingsPath, 'utf-8')
    service.install()
    expect(readFileSync(settingsPath, 'utf-8')).toBe(upgraded)

    service.install({ claudeVersion: '2.1.62' })
    const downgraded = readHooksJson(settingsPath)
    expect(downgraded?.env).toEqual(user.env)
    expect(downgraded?.hooks?.Elicitation).toEqual([userHook])
    expect(downgraded?.hooks?.ElicitationResult).toEqual([userHook])
  })

  it('keeps the new registrations out of OpenClaude settings', () => {
    const service = new ClaudeHookService({
      agent: 'openclaude',
      displayName: 'OpenClaude',
      settings: OPENCLAUDE_HOOK_SETTINGS
    })
    expect(service.install({ claudeVersion: '2.1.63' }).state).toBe('installed')
    const written = readHooksJson(join(tmpHome, '.openclaude', 'settings.json'))
    expect(written?.hooks?.PermissionRequest).toBeDefined()
    expect(written?.hooks?.Elicitation).toBeUndefined()
    expect(written?.hooks?.ElicitationResult).toBeUndefined()
  })
})
