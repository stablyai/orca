import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
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
import { GrokHookService } from './hook-service'

const GROK_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'grok-hook.cmd' : 'grok-hook.sh'
const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -EncodedCommand \S+$/

// Bare cmd-safe paths and encoded fallback launchers both identify the managed Windows script.
function registersManagedGrokScript(command: string): boolean {
  return command.includes(GROK_SCRIPT_FILE_NAME) || WINDOWS_POWERSHELL_LAUNCHER.test(command)
}

describe('GrokHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-grok-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('does not restore a user-cleared global hook config on the next launch', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const userClearedConfig = '{  "hooks" : {}  }\n'

    expect(service.install().state).toBe('installed')
    writeFileSync(configPath, userClearedConfig, 'utf8')

    service.install()

    expect(readFileSync(configPath, 'utf8')).toBe(userClearedConfig)
  })

  it('preserves a user-cleared config during session cleanup', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const userClearedConfig = '{  "hooks" : {}  }\n'

    expect(service.install().state).toBe('installed')
    writeFileSync(configPath, userClearedConfig, 'utf8')

    expect(service.remove().state).toBe('not_installed')
    expect(readFileSync(configPath, 'utf8')).toBe(userClearedConfig)
  })

  it('removes the managed config even when a non-hook key remains', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')

    expect(service.install().state).toBe('installed')
    const withSchema = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    withSchema.$schema = 'https://grok.example/hooks.schema.json'
    writeFileSync(configPath, `${JSON.stringify(withSchema, null, 2)}\n`, 'utf8')

    expect(service.remove().state).toBe('not_installed')

    expect(existsSync(configPath)).toBe(false)
    expect(service.install().state).toBe('installed')
  })

  // Respect startup opt-out while allowing explicit re-enabling to override it.

  it('restores a user-cleared config when the user turns hooks back on', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const userCleared = '{  "hooks" : {}  }\n'

    expect(service.install().state).toBe('installed')
    writeFileSync(configPath, userCleared, 'utf8')

    expect(service.install({ userInitiated: true }).state).toBe('installed')

    expect(readFileSync(configPath, 'utf8')).not.toBe(userCleared)
    expect(service.getStatus().managedHooksPresent).toBe(true)
  })

  // Strip managed entries through symlinks so user dotfile links stay connected.
  it('writes through a symlinked config instead of destroying the link', async () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const realConfig = join(homeDir, 'dotfiles', 'orca-status.json')

    expect(service.install().state).toBe('installed')
    mkdirSync(dirname(realConfig), { recursive: true })
    renameSync(configPath, realConfig)
    symlinkSync(realConfig, configPath)

    await service.removeAsync()

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(existsSync(realConfig)).toBe(true)
    expect(service.getStatus().managedHooksPresent).toBe(false)
  })

  it('respects an empty user-managed symlink as an opt-out', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const realConfig = join(homeDir, 'dotfiles', 'orca-status.json')
    const userCleared = '{"hooks":{}}\n'
    mkdirSync(dirname(configPath), { recursive: true })
    mkdirSync(dirname(realConfig), { recursive: true })
    writeFileSync(realConfig, userCleared)
    symlinkSync(realConfig, configPath)

    expect(service.install().state).toBe('not_installed')
    expect(readFileSync(realConfig, 'utf8')).toBe(userCleared)
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
  })

  it('writes through a symlinked config on the sync remove path too', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const realConfig = join(homeDir, 'dotfiles', 'orca-status.json')

    expect(service.install().state).toBe('installed')
    mkdirSync(dirname(realConfig), { recursive: true })
    renameSync(configPath, realConfig)
    symlinkSync(realConfig, configPath)

    expect(service.remove().state).toBe('not_installed')

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(existsSync(realConfig)).toBe(true)
    expect(service.getStatus().managedHooksPresent).toBe(false)
  })

  // Identify Orca's prior emptying separately from a deliberate user opt-out after restart.
  it('reinstalls into a symlinked config on the launch after a quit', async () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const realConfig = join(homeDir, 'dotfiles', 'orca-status.json')

    expect(service.install().state).toBe('installed')
    mkdirSync(dirname(realConfig), { recursive: true })
    renameSync(configPath, realConfig)
    symlinkSync(realConfig, configPath)
    await service.removeAsync()
    expect(service.getStatus().managedHooksPresent).toBe(false)

    expect(new GrokHookService().install().state).toBe('installed')

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(existsSync(realConfig)).toBe(true)
    expect(service.getStatus().managedHooksPresent).toBe(true)
  })

  it('preserves user-authored hook entries in the Orca Grok config file', () => {
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          hooks: {
            Notification: [
              {
                hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    )

    new GrokHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const commands = config.hooks.Notification.flatMap((definition) =>
      definition.hooks.map((hook) => hook.command)
    )
    expect(commands).toContain('/usr/local/bin/user-hook')
    expect(commands.some(registersManagedGrokScript)).toBe(true)
  })
})
