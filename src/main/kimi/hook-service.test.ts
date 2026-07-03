import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KimiHookService } from './hook-service'
import { KIMI_HOOK_EVENTS } from './kimi-hook-config-toml'

// Why: getSharedManagedScriptPath() writes the managed script under
// homedir()/.orca, and getKimiHome() honors KIMI_CODE_HOME. Point both at a
// temp dir so the local install/remove cycle never touches the real ~/.orca or
// ~/.kimi-code. os.homedir() resolves $HOME on POSIX (verified at write time).
let home: string
let originalHome: string | undefined
let originalKimiHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-kimi-hook-'))
  originalHome = process.env.HOME
  originalKimiHome = process.env.KIMI_CODE_HOME
  process.env.HOME = home
  process.env.KIMI_CODE_HOME = join(home, '.kimi-code')
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalKimiHome === undefined) {
    delete process.env.KIMI_CODE_HOME
  } else {
    process.env.KIMI_CODE_HOME = originalKimiHome
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.kimi-code', 'config.toml')
const scriptPath = (): string => join(home, '.orca', 'agent-hooks', 'kimi-hook.sh')

describe('KimiHookService', () => {
  it('reports not_installed before install', () => {
    expect(new KimiHookService().getStatus().state).toBe('not_installed')
  })

  it('installs the managed hooks block and the managed script', () => {
    const status = new KimiHookService().install()
    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const config = readFileSync(configPath(), 'utf-8')
    for (const event of KIMI_HOOK_EVENTS) {
      expect(config).toContain(`event = "${event}"`)
    }
    // The managed script must exist and POST to the Kimi hook endpoint.
    const script = readFileSync(scriptPath(), 'utf-8')
    expect(script).toContain('/hook/kimi')
    // The command Kimi runs points at the managed script via sh.
    expect(config).toContain('agent-hooks/kimi-hook.sh')
  })

  it('keeps user config when installing, then restores it on remove', () => {
    const dir = join(home, '.kimi-code')
    mkdirSync(dir, { recursive: true })
    // Pre-existing user config with their own provider.
    const userConfig =
      'default_model = "kimi-k2.6"\n\n[providers."mine"]\ntype = "openai"\napi_key = "sk-secret"\n'
    writeFileSync(configPath(), userConfig)

    const service = new KimiHookService()
    expect(service.install().state).toBe('installed')

    const installed = readFileSync(configPath(), 'utf-8')
    expect(installed).toContain('api_key = "sk-secret"')
    expect(installed).toContain('default_model = "kimi-k2.6"')

    // Reinstall must not duplicate the managed block.
    service.install()
    const reinstalled = readFileSync(configPath(), 'utf-8')
    expect((reinstalled.match(/orca-managed-kimi-hooks \(/g) ?? []).length).toBe(1)

    const removed = service.remove()
    expect(removed.state).toBe('not_installed')
    const afterRemove = readFileSync(configPath(), 'utf-8')
    expect(afterRemove).toBe(userConfig)
  })
})
