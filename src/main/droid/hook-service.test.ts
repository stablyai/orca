import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

import { isPlainObject } from '../agent-hooks/installation/configuration/hooks-json-read'
import { droidHookService } from './hook-service'
import { localDiskSftp } from '../agent-hooks/installation/remote/local-disk-sftp.test-fixture'

const EVENTS = [
  'Notification',
  'PostToolUse',
  'PreToolUse',
  'SessionStart',
  'Stop',
  'SubagentStop',
  'UserPromptSubmit'
]
const USER_STOP = [{ hooks: [{ type: 'command', command: 'say done' }] }]
const USER_GUARD = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard-rm' }] }]

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function managedEvents(events: unknown): string[] {
  return Object.entries(isPlainObject(events) ? events : {})
    .filter(([, definitions]) => JSON.stringify(definitions).includes('droid-hook.'))
    .map(([event]) => event)
    .sort()
}

describe('Droid managed hooks', () => {
  let home: string
  let factoryDir: string
  let hooksPath: string
  let settingsPath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-droid-hooks-'))
    factoryDir = join(home, '.factory')
    hooksPath = join(factoryDir, 'hooks.json')
    settingsPath = join(factoryDir, 'settings.json')
    mkdirSync(factoryDir, { recursive: true })
    homedirMock.mockReturnValue(home)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  // Droid's merge: each hooks.json event replaces the same settings.json event.
  function effectiveHooks(hooksFile = hooksPath): Record<string, unknown> {
    const hooks = existsSync(hooksFile) ? readJson(hooksFile) : {}
    return Object.assign({}, readJson(settingsPath).hooks, hooks)
  }

  it.each(['local', 'remote'] as const)(
    'adds %s managed hooks to hooks.json only for events it defines',
    async (target) => {
      const staleOrca = {
        hooks: [{ type: 'command', command: '/old/.orca/agent-hooks/droid-hook.sh' }]
      }
      const settingsHooks = { Stop: [...USER_STOP, staleOrca], PreToolUse: USER_GUARD }
      writeFileSync(settingsPath, JSON.stringify({ model: 'x', hooks: settingsHooks }))
      const hooksFile = { Stop: USER_STOP, showHookOutput: false }
      writeFileSync(hooksPath, JSON.stringify(hooksFile))
      expect(droidHookService.getStatus()).toMatchObject({ state: 'not_installed' })

      const status =
        target === 'local'
          ? droidHookService.install()
          : await droidHookService.installRemote(localDiskSftp(), home)

      expect(status).toMatchObject({ state: 'installed', configPath: settingsPath })
      expect(managedEvents(readJson(hooksPath))).toEqual(['Stop'])
      expect(managedEvents(effectiveHooks())).toEqual(EVENTS)
      // The user's settings.json PreToolUse guard must still run.
      expect(effectiveHooks()).toMatchObject({
        Stop: [USER_STOP[0], {}],
        PreToolUse: [USER_GUARD[0], {}]
      })
      // Uninstall must disclose hooks.json while it carries Orca's entries.
      expect(droidHookService.getStatus()).toMatchObject({
        state: 'installed',
        additionalConfigPaths: [hooksPath]
      })

      expect(droidHookService.remove()).toMatchObject({ state: 'not_installed' })
      expect(readJson(hooksPath)).toEqual(hooksFile)
      expect(readJson(settingsPath)).toEqual({
        model: 'x',
        hooks: { Stop: USER_STOP, PreToolUse: USER_GUARD }
      })
    }
  )

  it('keeps every hook in settings.json when hooks.json is absent', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: USER_GUARD } }))

    expect(droidHookService.install()).toMatchObject({ state: 'installed' })
    expect(existsSync(hooksPath)).toBe(false)
    expect(readJson(settingsPath).hooks).toMatchObject({ PreToolUse: [USER_GUARD[0], {}] })
    expect(managedEvents(effectiveHooks())).toEqual(EVENTS)
  })

  // A hooks.json `[]` hides that settings.json event, so uninstall must not drop it.
  it('keeps an empty hooks.json event the user wrote', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: USER_STOP } }))
    writeFileSync(hooksPath, JSON.stringify({ Stop: [] }))

    droidHookService.install()
    expect(managedEvents(readJson(hooksPath))).toEqual(['Stop'])
    droidHookService.remove()
    expect(readJson(hooksPath)).toEqual({ Stop: [] })
  })

  // Droid parses hooks.json as JSONC and ignores it on any parse error.
  it.each([
    {
      name: 'JSONC',
      text: '{ // audit\n "Stop": [] }',
      state: 'partial',
      detail: (path: string): string | null =>
        `Managed hook missing for events: Stop; ${path} has comments; Orca cannot edit it`
    },
    { name: 'malformed', text: '{ "Stop": [', state: 'installed', detail: () => null }
  ])('installs settings.json hooks beside a $name hooks.json', async ({ text, state, detail }) => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: USER_STOP } }))
    writeFileSync(hooksPath, text)

    expect(droidHookService.install()).toMatchObject({ state, detail: detail(hooksPath) })
    expect(await droidHookService.installRemote(localDiskSftp(), home)).toMatchObject({
      state,
      detail: detail(`${home}/.factory/hooks.json`)
    })
    expect(readFileSync(hooksPath, 'utf-8')).toBe(text)
    expect(droidHookService.remove()).toMatchObject({ state: 'not_installed' })
    expect(readJson(settingsPath)).toEqual({ hooks: { Stop: USER_STOP } })
  })

  // Droid rejects a hooks.json whose event is not an array, so Orca must not repair it into use.
  it('leaves a non-array hooks.json event alone', () => {
    writeFileSync(settingsPath, '{}')
    writeFileSync(hooksPath, JSON.stringify({ Stop: null }))

    droidHookService.install()
    expect(readJson(hooksPath)).toEqual({ Stop: null })
  })

  it.each(['local', 'remote'] as const)(
    'installs %s hooks beside non-object hook entries',
    async (target) => {
      const settingsHooks = { Stop: [null, { hooks: [null] }] }
      writeFileSync(settingsPath, JSON.stringify({ hooks: settingsHooks }))
      writeFileSync(hooksPath, JSON.stringify({ PreToolUse: [null] }))

      const status =
        target === 'local'
          ? droidHookService.install()
          : await droidHookService.installRemote(localDiskSftp(), home)

      expect(status).toMatchObject({ state: 'installed' })
      expect(managedEvents(readJson(settingsPath).hooks)).toEqual(EVENTS)
      expect(droidHookService.remove()).toMatchObject({ state: 'not_installed' })
      expect(readJson(settingsPath)).toEqual({ hooks: settingsHooks })
      expect(readJson(hooksPath)).toEqual({ PreToolUse: [null] })
    }
  )

  it('reports hooksDisabled set in hooks.json', () => {
    writeFileSync(settingsPath, '{}')
    writeFileSync(hooksPath, JSON.stringify({ hooksDisabled: true }))

    expect(droidHookService.install()).toMatchObject({
      state: 'partial',
      detail: 'Droid hooks are disabled in Factory settings'
    })
    expect(readJson(hooksPath)).toEqual({ hooksDisabled: true })
  })

  // A directory stands in for any read failure other than a missing file.
  it('installs settings.json hooks when hooks.json cannot be read', async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: USER_STOP } }))
    mkdirSync(hooksPath)

    expect(droidHookService.install()).toMatchObject({ state: 'installed' })
    expect(await droidHookService.installRemote(localDiskSftp(), home)).toMatchObject({
      state: 'installed',
      configPath: `${home}/.factory/settings.json`
    })
    expect(managedEvents(readJson(settingsPath).hooks)).toEqual(EVENTS)
  })

  // Droid reads the legacy hooks/hooks.json only while hooks.json is absent.
  it('edits the legacy hooks/hooks.json while hooks.json is absent', async () => {
    const legacyPath = join(factoryDir, 'hooks', 'hooks.json')
    mkdirSync(join(factoryDir, 'hooks'))
    writeFileSync(legacyPath, JSON.stringify({ Stop: USER_STOP }))

    expect(droidHookService.install()).toMatchObject({
      state: 'installed',
      additionalConfigPaths: [legacyPath]
    })
    await droidHookService.installRemote(localDiskSftp(), home)
    expect(existsSync(hooksPath)).toBe(false)
    expect(managedEvents(readJson(legacyPath))).toEqual(['Stop'])
    expect(managedEvents(effectiveHooks(legacyPath))).toEqual(EVENTS)
  })
})
