import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as OsModule from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zcodeHookService } from './hook-service'
import { ZCODE_HOOK_EVENTS } from './hook-settings'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof OsModule>('node:os')
  return { ...actual, homedir: homedirMock }
})

const USER_SETTINGS = [
  '{',
  '  "hooks": {',
  '    "enabled": false,',
  '    "events": { "Stop": [{ "hooks": [{ "type": "command", "command": "node mine.mjs" }] }] }',
  '  },',
  '  "mcp": { "servers": { "mine": { "command": "npx" } } }',
  '}',
  ''
].join('\n')
const USER_SETTINGS_JSON = JSON.parse(USER_SETTINGS)

const readSettings = (
  path: string
): { hooks: { enabled: boolean; events: Record<string, unknown> }; mcp: unknown } =>
  JSON.parse(readFileSync(path, 'utf8'))
const managedEvents = (path: string): readonly string[] =>
  ZCODE_HOOK_EVENTS.filter((event) =>
    JSON.stringify(readSettings(path).hooks.events[event] ?? []).includes('zcode-hook.')
  )

describe('ZCode status hooks across both settings files', () => {
  let home = ''
  let cliDir = ''
  const configJson = (): string => join(cliDir, 'config.json')
  const settingJson = (): string => join(cliDir, 'setting.json')

  afterEach(() => {
    delete process.env.ZCODE_CLI_SETTINGS_FILE
    if (home) {
      rmSync(home, { recursive: true, force: true })
    }
  })

  function makeHome(): void {
    home = mkdtempSync(join(tmpdir(), 'orca-zcode-hooks-'))
    cliDir = join(home, '.zcode', 'cli')
    mkdirSync(cliDir, { recursive: true })
    homedirMock.mockReturnValue(home)
  }

  it('hooks the npm distribution’s setting.json too, only once it exists, and names the file that fell behind', () => {
    makeHome()

    // That CLI creates the file on its first launch; Orca must not get there first.
    expect(zcodeHookService.install()).toMatchObject({ state: 'installed' })
    expect(existsSync(settingJson())).toBe(false)

    writeFileSync(settingJson(), USER_SETTINGS)
    expect(zcodeHookService.install()).toMatchObject({ state: 'installed' })
    expect(managedEvents(configJson())).toEqual(ZCODE_HOOK_EVENTS)
    expect(managedEvents(settingJson())).toEqual(ZCODE_HOOK_EVENTS)
    expect(readSettings(settingJson()).hooks.enabled).toBe(true)
    expect(readSettings(settingJson()).mcp).toEqual(USER_SETTINGS_JSON.mcp)

    // A CLI that resets its settings, or one installed after Orca, drops only its own copy.
    writeFileSync(settingJson(), USER_SETTINGS)
    expect(zcodeHookService.getStatus()).toMatchObject({
      state: 'not_installed',
      configPath: settingJson(),
      managedHooksPresent: true
    })

    zcodeHookService.install()
    zcodeHookService.remove()
    expect(managedEvents(configJson())).toEqual([])
    expect(readSettings(configJson()).hooks.events).toEqual({})
    expect(managedEvents(settingJson())).toEqual([])
    expect(readSettings(settingJson()).hooks.events).toEqual(USER_SETTINGS_JSON.hooks.events)
    expect(readSettings(settingJson()).mcp).toEqual(USER_SETTINGS_JSON.mcp)
  })

  it('follows ZCODE_CLI_SETTINGS_FILE to the file that CLI is told to read', () => {
    makeHome()
    const custom = join(home, 'cli-settings.json')
    writeFileSync(custom, USER_SETTINGS)
    process.env.ZCODE_CLI_SETTINGS_FILE = custom

    expect(zcodeHookService.install()).toMatchObject({ state: 'installed' })
    expect(managedEvents(custom)).toEqual(ZCODE_HOOK_EVENTS)
    expect(existsSync(settingJson())).toBe(false)
  })
})
