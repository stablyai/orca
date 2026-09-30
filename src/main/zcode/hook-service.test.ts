import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => hoisted.home }
})
vi.mock('electron', () => ({ app: { getPath: () => hoisted.home } }))

import { zcodeHookService } from './hook-service'
import { getZCodeConfigPath, ZCODE_HOOK_EVENTS } from './hook-settings'

type ManagedHookEntry = { type: string; command: string; timeout?: number }
type ZCodeConfigFile = {
  hooks?: { enabled?: boolean; events?: Record<string, { hooks: ManagedHookEntry[] }[]> }
  [key: string]: unknown
}

// Why no assertion: `JSON.parse` is already `any`, so the annotation narrows without a cast.
function readConfig(): ZCodeConfigFile {
  return JSON.parse(readFileSync(getZCodeConfigPath(), 'utf-8'))
}

beforeEach(() => {
  hoisted.home = mkdtempSync(join(tmpdir(), 'orca-zcode-'))
})
afterEach(() => {
  rmSync(hoisted.home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('ZCodeHookService', () => {
  it('reports not_installed before any install', () => {
    expect(zcodeHookService.getStatus()).toMatchObject({
      agent: 'zcode',
      state: 'not_installed',
      managedHooksPresent: false
    })
  })

  it('creates config.json with every lifecycle event and enables hooks', () => {
    const status = zcodeHookService.install()
    expect(status).toMatchObject({ agent: 'zcode', state: 'installed', managedHooksPresent: true })
    const config = readConfig()
    // Why: ZCode's DefaultRuntimeConfig ships `hooks.enabled: false`, so registering the
    // events without this flag is exactly the "hooks never fire" report in zai-org/feedback#32.
    expect(config.hooks?.enabled).toBe(true)
    expect(Object.keys(config.hooks?.events ?? {}).sort()).toEqual([...ZCODE_HOOK_EVENTS].sort())
    for (const event of ZCODE_HOOK_EVENTS) {
      expect(config.hooks?.events?.[event]?.[0]?.hooks?.[0]?.command).toContain('zcode-hook')
    }
  })

  it('is idempotent — a second install adds no duplicate entries', () => {
    zcodeHookService.install()
    const first = readFileSync(getZCodeConfigPath(), 'utf-8')
    zcodeHookService.install()
    expect(readFileSync(getZCodeConfigPath(), 'utf-8')).toBe(first)
    const config = readConfig()
    expect(config.hooks?.events?.Stop).toHaveLength(1)
  })

  it("preserves the user's own hooks, key order, and unrelated config", () => {
    const configPath = getZCodeConfigPath()
    mkdirSync(join(hoisted.home, '.zcode', 'cli'), { recursive: true })
    // Why plain JSON and not JSONC: ZCode's loader is a strict `JSON.parse`
    // (`packages/adapters/src/config/file-config.adapter.ts`), so a comment would make
    // ZCode drop the whole file. The in-place edit still matters — it keeps the user's
    // key order and indentation instead of reserializing their config.
    writeFileSync(
      configPath,
      `{
  "ui": { "theme": "dark" },
  "telemetry": { "enabled": false },
  "hooks": {
    "enabled": true,
    "events": {
      "Stop": [{ "hooks": [{ "type": "command", "command": "my-own-hook.sh" }] }]
    }
  }
}
`
    )
    zcodeHookService.install()
    const text = readFileSync(configPath, 'utf-8')
    expect(text).toContain('my-own-hook.sh')
    expect(text).toContain('"theme": "dark"')
    // Key order is untouched: `ui` still precedes `telemetry`, which still precedes `hooks`.
    expect(text.indexOf('"ui"')).toBeLessThan(text.indexOf('"telemetry"'))
    expect(text.indexOf('"telemetry"')).toBeLessThan(text.indexOf('"hooks"'))
    const config = readConfig()
    expect(config.hooks?.events?.Stop).toHaveLength(2)
    // The managed entry is appended, so the user's own hook still runs first.
    expect(config.hooks?.events?.Stop?.[0]?.hooks?.[0]?.command).toBe('my-own-hook.sh')
  })

  it('leaves a config ZCode itself can parse (strict JSON, no comments)', () => {
    zcodeHookService.install()
    expect(() => JSON.parse(readFileSync(getZCodeConfigPath(), 'utf-8'))).not.toThrow()
  })

  it('removes only Orca-managed entries and leaves the user their hooks', () => {
    const configPath = getZCodeConfigPath()
    mkdirSync(join(hoisted.home, '.zcode', 'cli'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: {
          enabled: true,
          events: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }] }
        }
      })
    )
    zcodeHookService.install()
    zcodeHookService.remove()
    const config = readConfig()
    expect(config.hooks?.events?.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }
    ])
    // Why: the user may run their own hooks; remove() must not switch the runtime off.
    expect(config.hooks?.enabled).toBe(true)
    expect(zcodeHookService.getStatus().managedHooksPresent).toBe(false)
  })

  it('leaves an unrelated empty event key alone while removing its own', () => {
    const configPath = getZCodeConfigPath()
    mkdirSync(join(hoisted.home, '.zcode', 'cli'), { recursive: true })
    // Why: `Notification` is not an event Orca manages, and an empty list is a legitimate
    // thing for a user to have written. Removing Orca's hooks must not take it with them.
    writeFileSync(
      configPath,
      JSON.stringify({ hooks: { enabled: true, events: { Notification: [] } } })
    )
    zcodeHookService.install()
    zcodeHookService.remove()
    const config = readConfig()
    expect(config.hooks?.events?.Notification).toEqual([])
    for (const event of ZCODE_HOOK_EVENTS) {
      expect(config.hooks?.events?.[event]).toBeUndefined()
    }
  })

  it('reports partial when the managed events are present but hooks are disabled', () => {
    zcodeHookService.install()
    const configPath = getZCodeConfigPath()
    const config: ZCodeConfigFile = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (config.hooks) {
      config.hooks.enabled = false
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    expect(zcodeHookService.getStatus()).toMatchObject({
      state: 'partial',
      managedHooksPresent: true,
      detail: expect.stringContaining('hooks.enabled')
    })
  })

  it('writes an executable managed hook script that posts to the ZCode endpoint', () => {
    zcodeHookService.install()
    const scriptPath = join(
      hoisted.home,
      '.orca',
      'agent-hooks',
      process.platform === 'win32' ? 'zcode-hook.cmd' : 'zcode-hook.sh'
    )
    expect(existsSync(scriptPath)).toBe(true)
    expect(readFileSync(scriptPath, 'utf-8')).toContain('/hook/zcode')
  })
})
