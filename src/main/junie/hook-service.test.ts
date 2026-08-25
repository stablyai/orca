import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { JunieHookService } from './hook-service'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  getJunieConfigPath,
  getJunieManagedCommand,
  getJunieManagedScriptPath,
  JUNIE_EVENTS
} from './hook-settings'

type ManagedHooksConfig = {
  hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
}

function readConfig(): ManagedHooksConfig {
  return JSON.parse(readFileSync(getJunieConfigPath(), 'utf8')) as ManagedHooksConfig
}

describe('JunieHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-junie-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs managed hooks into the user Junie config and posts to /hook/junie', () => {
    const status = new JunieHookService().install()

    expect(status.state).toBe('installed')
    expect(status.agent).toBe('junie')
    expect(status.configPath).toBe(join(homeDir, '.junie', 'config.json'))
    expect(status.managedHooksPresent).toBe(true)

    const config = readConfig()
    for (const event of JUNIE_EVENTS) {
      expect(config.hooks[event.eventName][0].hooks[0].command).toContain('junie-hook')
      // Junie parses matchers as regexes and treats an omitted one as "all";
      // Claude's "*" would not compile.
      expect(config.hooks[event.eventName][0].matcher).toBeUndefined()
    }
    // Junie has no PostToolUse event — installing one would be dead config.
    expect(config.hooks.PostToolUse).toBeUndefined()

    const script = readFileSync(getJunieManagedScriptPath(), 'utf8')
    expect(script).toContain('/hook/junie')
    expect(script).toContain('printf \'%s\' "$payload" | curl')
    expect(script).toContain('--data-urlencode "payload@-"')
    // Junie feeds non-empty non-JSON hook stdout back to the agent as context,
    // so the script must stay silent on stdout.
    expect(script).not.toContain('printf "{}')
  })

  it('honors JUNIE_HOME for the config location', () => {
    const junieHome = join(homeDir, 'custom-junie')
    vi.stubEnv('JUNIE_HOME', junieHome)

    const status = new JunieHookService().install()

    expect(status.configPath).toBe(join(junieHome, 'config.json'))
  })

  it('preserves unrelated keys when installing hooks', () => {
    const configPath = getJunieConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify({ model: 'gpt-5', effort: 'high' }, null, 2)}\n`)

    new JunieHookService().install()

    const config = readConfig() as ManagedHooksConfig & { model: string; effort: string }
    expect(config.model).toBe('gpt-5')
    expect(config.effort).toBe('high')
    expect(config.hooks.UserPromptSubmit).toBeDefined()
  })

  it('reports not_installed before install and clears managed hooks on remove', () => {
    const service = new JunieHookService()
    expect(service.getStatus().state).toBe('not_installed')

    service.install()
    const removed = service.remove()

    expect(removed.state).toBe('not_installed')
    expect(removed.managedHooksPresent).toBe(false)
    expect(readConfig().hooks?.UserPromptSubmit).toBeUndefined()
  })

  it('keeps a user hook while removing only the managed one', () => {
    const configPath = getJunieConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    const userHook = { hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }
    writeFileSync(configPath, `${JSON.stringify({ hooks: { Stop: [userHook] } }, null, 2)}\n`)

    const service = new JunieHookService()
    service.install()
    service.remove()

    expect(readConfig().hooks.Stop).toEqual([userHook])
  })

  it('returns partial status when only some managed hooks remain', () => {
    const service = new JunieHookService()
    service.install()
    const config = readConfig()
    delete config.hooks.Stop
    writeFileSync(getJunieConfigPath(), `${JSON.stringify(config, null, 2)}\n`)

    const status = service.getStatus()

    expect(status.state).toBe('partial')
    expect(status.detail).toContain('Stop')
    expect(status.managedHooksPresent).toBe(true)
  })

  it.each([
    ['a trailing comma', '{"model": "gpt-5",}'],
    // Junie parses config.json with kotlinx, which rejects comments outright; accepting
    // them here would report `installed` for hooks that can never fire.
    ['a comment', '{\n  // my config\n  "model": "gpt-5"\n}']
  ])('reports an error for %s instead of reporting installed', (_label, contents) => {
    const configPath = getJunieConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, contents)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(new JunieHookService().install().state).toBe('error')
      expect(readFileSync(configPath, 'utf8')).toBe(contents)
    } finally {
      warn.mockRestore()
    }
  })

  it('guards the managed hook command natively in cmd.exe on Windows', () => {
    const previous = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      // A spaced profile path is the common case and must not fall back to a
      // PowerShell launcher: Junie runs the command through `cmd.exe /c`, and
      // PowerShell startup would be paid on every tool call.
      const scriptPath = 'C:\\Users\\Ada Lovelace\\.orca\\agent-hooks\\junie-hook.cmd'
      const command = getJunieManagedCommand(scriptPath)

      expect(command).toBe(
        `if exist "${scriptPath}" (call "${scriptPath}") else ("%SystemRoot%\\System32\\more.com" >nul 2>nul)`
      )
      expect(command).not.toContain('-EncodedCommand')
      // A stale entry pointing at a removed script must still be swept.
      expect(createManagedCommandMatcher('junie-hook.cmd')(command)).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: previous })
    }
  })

  it('reports an error instead of overwriting a malformed config', () => {
    const configPath = getJunieConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{"hooks": }')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const status = new JunieHookService().install()

      expect(status.state).toBe('error')
      expect(readFileSync(configPath, 'utf8')).toBe('{"hooks": }')
    } finally {
      warn.mockRestore()
    }
  })
})
