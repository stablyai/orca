import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VibeHookService } from './hook-service'
import { VIBE_HOOK_TYPES } from './hook-config-toml'

// Why: getSharedManagedScriptPath() writes under homedir()/.orca and getVibeHome()
// honors VIBE_HOME. Point both at a temp dir so install/remove never touches the
// real ~/.orca or ~/.vibe. os.homedir() resolves $HOME on POSIX.
let home: string
let originalHome: string | undefined
let originalVibeHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-vibe-hook-'))
  originalHome = process.env.HOME
  originalVibeHome = process.env.VIBE_HOME
  process.env.HOME = home
  process.env.VIBE_HOME = join(home, '.vibe')
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalVibeHome === undefined) {
    delete process.env.VIBE_HOME
  } else {
    process.env.VIBE_HOME = originalVibeHome
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.vibe', 'hooks.toml')
const scriptPath = (): string => join(home, '.orca', 'agent-hooks', 'mistral-vibe-hook.sh')

describe('VibeHookService', () => {
  it('reports not_installed before install', () => {
    expect(new VibeHookService().getStatus().state).toBe('not_installed')
  })

  it('installs the managed hooks block and the managed script', () => {
    const status = new VibeHookService().install()
    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const config = readFileSync(configPath(), 'utf-8')
    for (const type of VIBE_HOOK_TYPES) {
      expect(config).toContain(`type = "${type}"`)
    }
    expect(config).toContain('name = "orca-pre-tool"')
    expect(config).toContain('name = "orca-post-tool"')
    expect(config).toContain('name = "orca-post-agent"')
    expect(config).toContain('agent-hooks/mistral-vibe-hook.sh')

    // The managed script must exist and POST to the Vibe hook endpoint.
    const script = readFileSync(scriptPath(), 'utf-8')
    expect(script).toContain('/hook/mistral-vibe')
    // Why: Orca is a read-only observer — the script must always pass through
    // (exit 0, empty stdout) and never emit a Vibe hook decision.
    expect(script).toMatch(/exit 0\s*$/)
    expect(script).not.toContain('empty-object')
  })

  it('reports partial when a hook type is missing', () => {
    new VibeHookService().install()
    // Simulate a hand-edit dropping the post_agent block.
    const full = readFileSync(configPath(), 'utf-8')
    const partial = full.replace(
      /\n\[\[hooks\]\]\nname = "orca-post-agent"[\s\S]*?description = "Orca status hook \(managed\)"/,
      ''
    )
    writeFileSync(configPath(), partial)
    const status = new VibeHookService().getStatus()
    expect(status.state).toBe('partial')
  })

  it('keeps user config when installing, then restores it on remove', () => {
    const dir = join(home, '.vibe')
    mkdirSync(dir, { recursive: true })
    const userConfig =
      'default_agent = "accept-edits"\n\n[[hooks]]\nname = "user-guard"\ntype = "pre_tool"\nmatch = "bash"\ncommand = "uv run python /path/to/guard"\n'
    writeFileSync(configPath(), userConfig)

    const service = new VibeHookService()
    expect(service.install().state).toBe('installed')

    const installed = readFileSync(configPath(), 'utf-8')
    expect(installed).toContain('name = "user-guard"')
    expect(installed).toContain('default_agent = "accept-edits"')

    // Reinstall must not duplicate the managed block.
    service.install()
    const reinstalled = readFileSync(configPath(), 'utf-8')
    expect((reinstalled.match(/orca-managed-vibe-hooks \(/g) ?? []).length).toBe(1)

    const removed = service.remove()
    expect(removed.state).toBe('not_installed')
    const afterRemove = readFileSync(configPath(), 'utf-8')
    expect(afterRemove).toBe(userConfig)
  })
})
