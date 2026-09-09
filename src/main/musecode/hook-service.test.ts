import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MusecodeHookService } from './hook-service'
import { MUSECODE_HOOK_EVENTS } from './hook-settings'

// Why: getSharedManagedScriptPath() writes under homedir()/.orca and the
// MuseCode config resolves via XDG_CONFIG_HOME ?? ~/.config/muse. Point HOME
// at a temp dir and clear XDG_CONFIG_HOME so install/remove never touches the
// real ~/.orca or ~/.config/muse. os.homedir() resolves $HOME on POSIX.
let home: string
let originalHome: string | undefined
let originalXdg: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-musecode-hook-'))
  originalHome = process.env.HOME
  originalXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdg
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.config', 'muse', 'settings.json')
const managedHooksPath = (): string => join(home, '.orca', 'agent-hooks', 'musecode-hooks.json')
const scriptPath = (): string => join(home, '.orca', 'agent-hooks', 'musecode-hook.sh')

describe('MusecodeHookService', () => {
  it('reports not_installed before install', () => {
    expect(new MusecodeHookService().getStatus().state).toBe('not_installed')
  })

  it('installs the managed hooks pointer, file, and script', () => {
    const status = new MusecodeHookService().install()
    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    // The settings pointer aims at the Orca-owned managed file, and a fresh
    // settings.json carries the schema_version muse requires.
    const settings = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    expect(settings.managed_hooks_path).toBe(managedHooksPath())
    expect(settings.schema_version).toBe(1)

    const managed = JSON.parse(readFileSync(managedHooksPath(), 'utf-8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    for (const event of MUSECODE_HOOK_EVENTS) {
      expect(managed.hooks[event]?.[0]?.hooks[0]?.command).toContain('agent-hooks/musecode-hook.sh')
    }
    // The managed script must exist and POST to the musecode hook endpoint.
    const script = readFileSync(scriptPath(), 'utf-8')
    expect(script).toContain('/hook/musecode')
    // Why: payload is piped to curl via stdin so it never lands on the curl
    // command line (EDR oversized-command-line false positive).
    expect(script).toContain('printf \'%s\' "$payload" | curl')
  })

  it('keeps user settings when installing, then drops only the pointer on remove', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    const userSettings = `{\n  "schema_version": 1,\n  "model": "muse-spark-1.2",\n  "approval_mode": "never"\n}\n`
    writeFileSync(configPath(), userSettings)

    const service = new MusecodeHookService()
    expect(service.install().state).toBe('installed')

    const installed = readFileSync(configPath(), 'utf-8')
    expect(installed).toContain('"model": "muse-spark-1.2"')
    expect(installed).toContain('"approval_mode": "never"')

    // Reinstall must converge without duplicating the pointer.
    service.install()
    const reinstalled = readFileSync(configPath(), 'utf-8')
    expect((reinstalled.match(/managed_hooks_path/g) ?? []).length).toBe(1)

    const removed = service.remove()
    expect(removed.state).toBe('not_installed')
    const afterRemove = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    expect(afterRemove.managed_hooks_path).toBeUndefined()
    expect(afterRemove.model).toBe('muse-spark-1.2')
  })

  it('reports not_installed when the pointer aims elsewhere', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    writeFileSync(
      configPath(),
      JSON.stringify({ schema_version: 1, managed_hooks_path: '/central/hooks.json' })
    )
    const status = new MusecodeHookService().getStatus()
    expect(status.state).toBe('not_installed')
    expect(status.detail).toContain('/central/hooks.json')
  })

  it('treats malformed managed hook entries as absent instead of throwing', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    mkdirSync(join(home, '.orca', 'agent-hooks'), { recursive: true })
    const managedPath = join(home, '.orca', 'agent-hooks', 'musecode-hooks.json')
    writeFileSync(configPath(), JSON.stringify({ schema_version: 1 }))
    const service = new MusecodeHookService()
    expect(service.install().state).toBe('installed')
    // Hand-edited damage: null definition, non-array hooks, null entry,
    // non-string command — status must degrade, never throw.
    const damaged = JSON.parse(readFileSync(managedPath, 'utf-8')) as {
      hooks: Record<string, unknown>
    }
    damaged.hooks.UserPromptSubmit = [
      null,
      { hooks: 'not-an-array' },
      { hooks: [null, { command: 42 }] }
    ]
    writeFileSync(managedPath, JSON.stringify(damaged))
    expect(() => service.getStatus()).not.toThrow()
    expect(service.getStatus().state).toBe('partial')
  })
})
