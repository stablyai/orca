import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

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

import { DevinHookService } from './hook-service'
import {
  getDevinConfigPath,
  getDevinManagedCommand,
  getDevinManagedScriptFileName
} from './hook-settings'

describe('DevinHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-devin-home-'))
    homedirMock.mockReturnValue(homeDir)
    vi.stubEnv('APPDATA', join(homeDir, '.config'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs managed hooks into user Devin config and posts to /hook/devin', () => {
    const status = new DevinHookService().install()

    expect(status.state).toBe('installed')
    expect(status.agent).toBe('devin')
    expect(status.configPath).toBe(join(homeDir, '.config', 'devin', 'config.json'))
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(
      readFileSync(join(homeDir, '.config', 'devin', 'config.json'), 'utf8')
    ) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
      agent?: { model: string }
    }
    for (const eventName of [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'PostCompaction',
      'SessionEnd'
    ]) {
      expect(config.hooks[eventName][0].hooks[0].command).toContain('devin-hook')
    }
    for (const eventName of ['PreToolUse', 'PostToolUse', 'PermissionRequest']) {
      expect(config.hooks[eventName][0].matcher).toBeUndefined()
    }
    const script = readFileSync(
      join(homeDir, '.orca', 'agent-hooks', getDevinManagedScriptFileName()),
      'utf8'
    )
    expect(script).toContain('/hook/devin')
  })

  it('preserves unrelated keys in Devin config when installing hooks', () => {
    const configPath = join(homeDir, '.config', 'devin', 'config.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify({ permissions: { mode: 'normal' }, hooks: {} }, null, 2)}\n`
    )

    new DevinHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      permissions: { mode: string }
      hooks: Record<string, unknown>
    }
    expect(config.permissions.mode).toBe('normal')
    expect(config.hooks.UserPromptSubmit).toBeDefined()
  })

  it('installs when Devin config uses JSONC comments', () => {
    const configPath = join(homeDir, '.config', 'devin', 'config.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `{
  // user hooks
  "hooks": {}
}
`
    )

    const status = new DevinHookService().install()

    expect(status.state).toBe('installed')
    expect(JSON.parse(readFileSync(configPath, 'utf8')).hooks.UserPromptSubmit).toBeDefined()
  })

  it('surfaces read_config_from overlap in status detail', () => {
    const configPath = join(homeDir, '.config', 'devin', 'config.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify({ hooks: {}, read_config_from: { claude: true } }, null, 2)}\n`
    )

    const status = new DevinHookService().getStatus()

    expect(status.detail).toContain('read_config_from')
    expect(status.detail).toContain('claude')
  })

  it('uses a cmd.exe wrapper for managed hook command on Windows', () => {
    const previous = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const scriptPath = 'C:\\Users\\Ada Lovelace\\.orca\\agent-hooks\\devin-hook.cmd'
      expect(getDevinManagedCommand(scriptPath)).toBe(
        'cmd /d /s /c ""C:\\Users\\Ada Lovelace\\.orca\\agent-hooks\\devin-hook.cmd""'
      )
    } finally {
      Object.defineProperty(process, 'platform', { value: previous })
    }
  })

  it('reports not_installed when Devin config has no managed hooks', () => {
    const configPath = join(homeDir, '.config', 'devin', 'config.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify({ hooks: {} }, null, 2)}\n`)

    const status = new DevinHookService().getStatus()

    expect(status.state).toBe('not_installed')
    expect(status.managedHooksPresent).toBe(false)
  })

  it('remove clears managed hook commands from Devin config', () => {
    const service = new DevinHookService()
    const installed = service.install()
    expect(installed.state).toBe('installed')

    const removed = service.remove()

    expect(removed.state).toBe('not_installed')
    const configPath = join(homeDir, '.config', 'devin', 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const commands = Object.values(config.hooks).flatMap((definitions) =>
      definitions.flatMap((definition) => definition.hooks.map((hook) => hook.command))
    )
    expect(commands.some((command) => command.includes('devin-hook'))).toBe(false)
  })

  it('returns partial status when some managed hooks are missing', () => {
    const configPath = join(homeDir, '.config', 'devin', 'config.json')
    const scriptPath = join(homeDir, '.orca', 'agent-hooks', getDevinManagedScriptFileName())
    const command = getDevinManagedCommand(scriptPath)
    mkdirSync(dirname(configPath), { recursive: true })
    mkdirSync(dirname(scriptPath), { recursive: true })
    writeFileSync(scriptPath, '#!/bin/sh\n')

    // Only install the managed hook for UserPromptSubmit
    writeFileSync(
      configPath,
      `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] } }, null, 2)}\n`
    )

    const status = new DevinHookService().getStatus()

    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toContain('Stop')
    expect(status.detail).toContain('PreToolUse')
    expect(status.detail).toContain('PostToolUse')
    expect(status.detail).toContain('PermissionRequest')
    expect(status.detail).toContain('SessionStart')
    expect(status.detail).toContain('PostCompaction')
    expect(status.detail).toContain('SessionEnd')
  })

  it('uses APPDATA on Windows for Devin config path', () => {
    const previous = process.platform
    const previousAppData = process.env.APPDATA
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming'
      expect(getDevinConfigPath()).toBe(
        join('C:\\Users\\test\\AppData\\Roaming', 'devin', 'config.json')
      )

      // Fallback when APPDATA is unset
      delete process.env.APPDATA
      expect(getDevinConfigPath()).toBe(join(homeDir, 'AppData', 'Roaming', 'devin', 'config.json'))
    } finally {
      Object.defineProperty(process, 'platform', { value: previous })
      if (previousAppData !== undefined) {
        process.env.APPDATA = previousAppData
      } else {
        delete process.env.APPDATA
      }
    }
  })
})
