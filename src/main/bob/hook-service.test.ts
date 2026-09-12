import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return { ...actual, homedir: homedirMock }
})

import { BobHookService } from './hook-service'
import {
  BOB_EVENTS,
  getBobConfigPath,
  getBobManagedCommand,
  getBobManagedScriptPath
} from './hook-settings'

type BobSettings = {
  hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>
  [key: string]: unknown
}

function readSettings(): BobSettings {
  return JSON.parse(readFileSync(getBobConfigPath(), 'utf-8')) as BobSettings
}

function writeSettings(value: unknown): void {
  const configPath = getBobConfigPath()
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(value, null, 2))
}

describe('BobHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-bob-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('writes settings.json under ~/.bob/settings on every platform', () => {
    expect(getBobConfigPath()).toBe(join(homeDir, '.bob', 'settings', 'settings.json'))
  })

  it('registers a managed hook for each event Bob accepts', () => {
    const status = new BobHookService().install()

    expect(status).toMatchObject({ agent: 'bob', state: 'installed', managedHooksPresent: true })
    const hooks = readSettings().hooks ?? {}
    expect(Object.keys(hooks).sort()).toEqual([...BOB_EVENTS].sort())
    for (const eventName of BOB_EVENTS) {
      expect(hooks[eventName]).toHaveLength(1)
    }
  })

  // Why: Bob validates each hook entry with a `.strict()` zod schema and silently discards ALL
  // global hooks when one entry carries an unknown key, so the written shape is the contract.
  it("writes only the keys Bob's strict schema allows", () => {
    new BobHookService().install()

    const definition = (readSettings().hooks ?? {}).Stop![0]!
    // Why: an omitted matcher means match-all to Bob; emitting one would narrow the hook.
    expect(Object.keys(definition)).toEqual(['hooks'])
    expect(Object.keys(definition.hooks[0]!).sort()).toEqual(['command', 'timeout', 'type'])
    expect(definition.hooks[0]).toMatchObject({ type: 'command' })
    expect(definition.hooks[0]!.command).toBe(getBobManagedCommand(getBobManagedScriptPath()))
  })

  it("preserves unrelated settings and the user's own hooks", () => {
    const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }
    writeSettings({ theme: 'dark', hooks: { PreToolUse: [userHook] } })

    new BobHookService().install()

    const settings = readSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.hooks!.PreToolUse).toHaveLength(2)
    expect(settings.hooks!.PreToolUse![0]).toEqual(userHook)
  })

  it('removes only Orca-managed hooks', () => {
    const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }
    writeSettings({ theme: 'dark', hooks: { PreToolUse: [userHook] } })
    const service = new BobHookService()
    service.install()

    const status = service.remove()

    expect(status).toMatchObject({ state: 'not_installed', managedHooksPresent: false })
    const settings = readSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.hooks!.PreToolUse).toEqual([userHook])
    // Why: events that held only the managed hook are dropped, not left as empty arrays.
    expect(settings.hooks!.Stop).toBeUndefined()
  })

  it('reports partial when only some events carry the managed hook', () => {
    const service = new BobHookService()
    service.install()
    const settings = readSettings()
    delete settings.hooks!.Stop
    writeSettings(settings)

    expect(service.getStatus()).toMatchObject({ state: 'partial', managedHooksPresent: true })
  })

  // Why: a malformed settings.json must not be overwritten — the user's file is the source of truth.
  it('refuses to install over an unparseable settings.json', () => {
    const configPath = getBobConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{ not json')

    expect(new BobHookService().install()).toMatchObject({ agent: 'bob', state: 'error' })
    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json')
  })
})
