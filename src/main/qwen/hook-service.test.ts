import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QwenHookService, QWEN_HOOK_EVENTS } from './hook-service'

// Why: getSharedManagedScriptPath() writes the managed script under
// homedir()/.orca, and getQwenHome() honors QWEN_HOME. Point both at a temp
// dir so the local install/remove cycle never touches the real ~/.orca or
// ~/.qwen. os.homedir() resolves $HOME on POSIX (verified at write time).
let home: string
let originalHome: string | undefined
let originalQwenHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-qwen-hook-'))
  originalHome = process.env.HOME
  originalQwenHome = process.env.QWEN_HOME
  process.env.HOME = home
  process.env.QWEN_HOME = join(home, '.qwen')
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalQwenHome === undefined) {
    delete process.env.QWEN_HOME
  } else {
    process.env.QWEN_HOME = originalQwenHome
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.qwen', 'settings.json')
const scriptPath = (): string => join(home, '.orca', 'agent-hooks', 'qwen-code-hook.sh')

type InstalledSettings = {
  env?: Record<string, string>
  model?: { name?: string }
  hooks?: Record<string, { hooks?: { command?: string; timeout?: number }[] }[]>
  [key: string]: unknown
}

function readSettings(): InstalledSettings {
  return JSON.parse(readFileSync(configPath(), 'utf-8')) as InstalledSettings
}

function managedCommands(settings: InstalledSettings, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((definition) =>
    (definition.hooks ?? []).flatMap((hook) => (hook.command ? [hook.command] : []))
  )
}

describe('QwenHookService', () => {
  it('reports not_installed before install', () => {
    expect(new QwenHookService().getStatus().state).toBe('not_installed')
  })

  it('installs managed hooks for every event and the managed script', () => {
    const status = new QwenHookService().install()
    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const settings = readSettings()
    for (const event of QWEN_HOOK_EVENTS) {
      expect(managedCommands(settings, event).some((c) => c.includes('qwen-code-hook.sh'))).toBe(
        true
      )
      // Why: Qwen's command-hook timeout is milliseconds (default 60000).
      const managed = (settings.hooks?.[event] ?? [])
        .flatMap((definition) => definition.hooks ?? [])
        .find((hook) => hook.command?.includes('qwen-code-hook.sh'))
      expect(managed?.timeout).toBe(10000)
    }

    // The managed script must exist and POST to the Qwen hook endpoint.
    const script = readFileSync(scriptPath(), 'utf-8')
    expect(script).toContain('/hook/qwen-code')
    // Why: payload is piped to curl via stdin (`payload@-`) so it never lands
    // on the curl command line (EDR oversized-command-line false positive).
    expect(script).toContain('printf \'%s\' "$payload" | curl')
    expect(script).toContain('--data-urlencode "payload@-"')
  })

  it('keeps user settings when installing, then restores them on remove', () => {
    const dir = join(home, '.qwen')
    mkdirSync(dir, { recursive: true })
    // Pre-existing user settings (env keys, model, and a user-authored hook).
    const userSettings = {
      env: { QWEN_API_KEY: 'sk-secret' },
      model: { name: 'qwen3-coder' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-authored' }] }] }
    }
    writeFileSync(configPath(), JSON.stringify(userSettings, null, 2))

    const service = new QwenHookService()
    expect(service.install().state).toBe('installed')

    const installed = readSettings()
    expect(installed.env?.QWEN_API_KEY).toBe('sk-secret')
    expect(installed.model?.name).toBe('qwen3-coder')
    expect(managedCommands(installed, 'Stop')).toContain('echo user-authored')

    // Reinstall must not duplicate the managed entries.
    service.install()
    const reinstalled = readSettings()
    expect(
      managedCommands(reinstalled, 'Stop').filter((c) => c.includes('qwen-code-hook.sh'))
    ).toHaveLength(1)

    const removed = service.remove()
    expect(removed.state).toBe('not_installed')
    const afterRemove = readSettings()
    expect(afterRemove.env?.QWEN_API_KEY).toBe('sk-secret')
    expect(managedCommands(afterRemove, 'Stop')).toEqual(['echo user-authored'])
    // Managed-only events disappear entirely once the managed entry is removed.
    expect(afterRemove.hooks?.UserPromptSubmit).toBeUndefined()
  })

  it('reports error instead of clobbering malformed settings.json', () => {
    const dir = join(home, '.qwen')
    mkdirSync(dir, { recursive: true })
    const original = '{"hooks": }'
    writeFileSync(configPath(), original)

    const service = new QwenHookService()
    expect(service.getStatus().state).toBe('error')
    expect(service.install().state).toBe('error')
    expect(readFileSync(configPath(), 'utf-8')).toBe(original)
  })

  it('reports error when the managed script is deleted after install', () => {
    const service = new QwenHookService()
    expect(service.install().state).toBe('installed')

    rmSync(scriptPath())
    const status = service.getStatus()
    // Why: registrations without the script make every hook fail silently;
    // a false `installed` would hide the breakage from the UI.
    expect(status.state).toBe('error')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toContain('qwen-code-hook.sh')
  })
})
