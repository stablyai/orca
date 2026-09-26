import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMuseSettingsText } from './hook-config-json'
import { MuseHookService } from './hook-service'
import { MUSE_HOOK_EVENTS } from './hook-settings'

// Why: getSharedManagedScriptPath() writes under homedir()/.orca and the
// Muse config resolves via XDG_CONFIG_HOME ?? ~/.config/muse. Point HOME
// at a temp dir and clear XDG_CONFIG_HOME so install/remove never touches the
// real ~/.orca or ~/.config/muse. os.homedir() resolves $HOME on POSIX.
let home: string
let originalHome: string | undefined
let originalXdg: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-muse-hook-'))
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
const managedHooksPath = (): string => join(home, '.orca', 'agent-hooks', 'muse-hooks.json')
const scriptPath = (): string => join(home, '.orca', 'agent-hooks', 'muse-hook.sh')

describe('MuseHookService', () => {
  it('reports not_installed before install', () => {
    expect(new MuseHookService().getStatus().state).toBe('not_installed')
  })

  it('installs the managed hooks pointer, file, and script', () => {
    const status = new MuseHookService().install()
    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    // The settings pointer aims at the Orca-owned managed file, and a fresh
    // settings.json carries the schema_version muse requires.
    const settings = parseMuseSettingsText(readFileSync(configPath(), 'utf-8'), 'test')
    expect(settings?.managed_hooks_path).toBe(managedHooksPath())
    expect(settings?.schema_version).toBe(1)
    expect(settings?.managed_hooks_env_vars).toContain('ORCA_PANE_KEY')

    const managedText = readFileSync(managedHooksPath(), 'utf-8')
    expect(managedText).toContain('agent-hooks/muse-hook.sh')
    expect(MUSE_HOOK_EVENTS.every((event) => managedText.includes(`"${event}"`))).toBe(true)
    // The managed script must exist and POST to the muse hook endpoint.
    const script = readFileSync(scriptPath(), 'utf-8')
    expect(script).toContain('/hook/muse')
    // Why: payload is piped to curl via stdin so it never lands on the curl
    // command line (EDR oversized-command-line false positive).
    expect(script).toContain('printf \'%s\' "$payload" | curl')
  })

  it('keeps user settings when installing, then drops only the pointer on remove', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    const userSettings = `{\n  "schema_version": 1,\n  "model": "muse-spark-1.2",\n  "approval_mode": "never"\n}\n`
    writeFileSync(configPath(), userSettings)

    const service = new MuseHookService()
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
    const afterRemove = parseMuseSettingsText(readFileSync(configPath(), 'utf-8'), 'test')
    expect(afterRemove?.managed_hooks_path).toBeUndefined()
    expect(afterRemove?.model).toBe('muse-spark-1.2')
  })

  it('reports not_installed when the pointer aims elsewhere', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    writeFileSync(
      configPath(),
      JSON.stringify({ schema_version: 1, managed_hooks_path: '/central/hooks.json' })
    )
    const status = new MuseHookService().getStatus()
    expect(status.state).toBe('not_installed')
    expect(status.detail).toContain('/central/hooks.json')
  })

  it('does not overwrite a user-managed hooks pointer during install', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    const userPath = '/user-owned/muse-hooks.json'
    writeFileSync(configPath(), JSON.stringify({ schema_version: 1, managed_hooks_path: userPath }))
    const status = new MuseHookService().install()
    expect(status.state).toBe('not_installed')
    expect(status.detail).toContain(userPath)
    expect(
      parseMuseSettingsText(readFileSync(configPath(), 'utf-8'), 'test')?.managed_hooks_path
    ).toBe(userPath)
  })

  it('treats malformed managed hook entries as absent instead of throwing', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    mkdirSync(join(home, '.orca', 'agent-hooks'), { recursive: true })
    const managedPath = join(home, '.orca', 'agent-hooks', 'muse-hooks.json')
    writeFileSync(configPath(), JSON.stringify({ schema_version: 1 }))
    const service = new MuseHookService()
    expect(service.install().state).toBe('installed')
    // Hand-edited damage: null definition, non-array hooks, null entry,
    // non-string command — status must degrade, never throw.
    const damaged = parseMuseSettingsText(readFileSync(managedPath, 'utf-8'), 'test')
    expect(damaged).not.toBeNull()
    if (!damaged) {
      throw new Error('expected generated Muse hooks')
    }
    damaged.hooks = {
      ...(typeof damaged.hooks === 'object' && damaged.hooks !== null ? damaged.hooks : {}),
      UserPromptSubmit: [null, { hooks: 'not-an-array' }, { hooks: [null, { command: 42 }] }]
    }
    writeFileSync(managedPath, JSON.stringify(damaged))
    expect(() => service.getStatus()).not.toThrow()
    expect(service.getStatus().state).toBe('partial')
  })
})
