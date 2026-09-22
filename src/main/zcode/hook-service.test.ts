import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZcodeHookService } from './hook-service'
import { ZCODE_HOOK_EVENTS } from './zcode-hook-config'

let home: string
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-zcode-hook-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalUserProfile
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.zcode', 'cli', 'config.json')
const scriptPath = (): string =>
  join(
    home,
    '.orca',
    'agent-hooks',
    process.platform === 'win32' ? 'zcode-hook.cmd' : 'zcode-hook.sh'
  )

describe('ZcodeHookService', () => {
  it('reports not_installed before install', () => {
    expect(new ZcodeHookService().getStatus().state).toBe('not_installed')
  })

  it('installs all managed hooks and the payload-safe bridge script', () => {
    const status = new ZcodeHookService().install()
    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(readFileSync(configPath(), 'utf-8')) as {
      hooks?: { enabled?: boolean; events?: Record<string, unknown[]>; [key: string]: unknown }
    }
    expect(config.hooks?.enabled).toBe(true)
    expect(config.hooks).not.toHaveProperty('orcaPreviousHooksEnabled')
    for (const event of ZCODE_HOOK_EVENTS) {
      expect(config.hooks?.events?.[event]).toBeDefined()
    }

    const script = readFileSync(scriptPath(), 'utf-8')
    expect(script).toContain('/hook/zcode')
    if (process.platform === 'win32') {
      expect(script).toContain('curl.exe')
      expect(script).toContain('--data-urlencode "payload@-"')
    } else {
      expect(script).toContain('printf \'%s\' "$payload" | curl')
      expect(script).toContain('--data-urlencode "payload@-"')
      expect(script).not.toContain('--data-urlencode "payload=${payload}"')
    }
  })

  it('keeps user config across install, reinstall, and remove', () => {
    const dir = join(home, '.zcode', 'cli')
    mkdirSync(dir, { recursive: true })
    const userConfig = {
      theme: 'dark',
      hooks: {
        enabled: false,
        events: {
          PreToolUse: [
            {
              matcher: 'Write',
              hooks: [{ type: 'command', command: 'echo user-hook', enabled: true }]
            }
          ]
        }
      }
    }
    writeFileSync(configPath(), `${JSON.stringify(userConfig, null, 2)}\n`)

    const service = new ZcodeHookService()
    expect(service.install().state).toBe('installed')
    service.install()

    type HookDef = { hooks?: { command?: string }[] }
    type Parsed = {
      theme?: string
      hooks?: { enabled?: boolean; events?: Record<string, HookDef[]> }
    }
    const installed = JSON.parse(readFileSync(configPath(), 'utf-8')) as Parsed
    expect(installed.theme).toBe('dark')
    const preTool = installed.hooks?.events?.PreToolUse ?? []
    expect(preTool.some((definition) => definition.hooks?.[0]?.command === 'echo user-hook')).toBe(
      true
    )
    expect(
      preTool
        .flatMap((definition) => definition.hooks ?? [])
        .filter((hook) => hook.command?.includes('zcode-hook'))
    ).toHaveLength(1)

    expect(service.remove().state).toBe('not_installed')
    const removed = JSON.parse(readFileSync(configPath(), 'utf-8')) as Parsed
    expect(removed.theme).toBe('dark')
    expect(removed.hooks?.enabled).toBe(false)
    expect(
      (removed.hooks?.events?.PreToolUse ?? []).some(
        (definition) => definition.hooks?.[0]?.command === 'echo user-hook'
      )
    ).toBe(true)
  })

  it('restores an absent hooks.enabled field on remove without writing private metadata', () => {
    const dir = join(home, '.zcode', 'cli')
    mkdirSync(dir, { recursive: true })
    writeFileSync(configPath(), `${JSON.stringify({ hooks: { events: {} } }, null, 2)}\n`)

    const service = new ZcodeHookService()
    expect(service.install().state).toBe('installed')
    const installed = JSON.parse(readFileSync(configPath(), 'utf-8')) as {
      hooks?: Record<string, unknown>
    }
    expect(installed.hooks).not.toHaveProperty('orcaPreviousHooksEnabled')

    expect(service.remove().state).toBe('not_installed')
    const removed = JSON.parse(readFileSync(configPath(), 'utf-8')) as {
      hooks?: Record<string, unknown>
    }
    expect(removed.hooks).not.toHaveProperty('enabled')
    expect(removed.hooks).not.toHaveProperty('orcaPreviousHooksEnabled')
  })
})
