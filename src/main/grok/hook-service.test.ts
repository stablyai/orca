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

import { GrokHookService } from './hook-service'

const GROK_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'grok-hook.cmd' : 'grok-hook.sh'
const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/

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

  it('installs a dedicated global Grok hook config and managed script', () => {
    const status = new GrokHookService().install()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(join(homeDir, '.grok', 'hooks', 'orca-status.json'))
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(
      readFileSync(join(homeDir, '.grok', 'hooks', 'orca-status.json'), 'utf8')
    ) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    expect(Object.keys(config.hooks).sort()).toEqual(
      [
        'Notification',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit'
      ].sort()
    )
    expect(config.hooks.PreToolUse[0].matcher).toBe('*')
    expect(config.hooks.PostToolUseFailure[0].matcher).toBe('*')
    expect(config.hooks.Notification[0].matcher).toBeUndefined()
    expect(config.hooks.PreToolUse[0].hooks[0].command).toMatch(
      process.platform === 'win32' ? WINDOWS_POWERSHELL_LAUNCHER : /grok-hook/
    )
    if (process.platform !== 'win32') {
      expect(config.hooks.PreToolUse[0].hooks[0].command).toContain(join(homeDir, '.orca'))
    }

    const script = readFileSync(
      join(homeDir, '.orca', 'agent-hooks', GROK_SCRIPT_FILE_NAME),
      'utf8'
    )
    expect(script).toContain('/hook/grok')
    if (process.platform === 'win32') {
      expect(script).toContain('%SystemRoot%\\System32\\curl.exe')
    } else {
      expect(script).toContain('payload=$(cat)')
    }
  })

  // Why: #6078 — a Windows user profile path with a space used to be written
  // verbatim as the hook command, so the agent split it at the space. The
  // managed command must use an encoded launcher so the path never appears raw
  // on the cmd.exe command line.
  it.skipIf(process.platform !== 'win32')(
    'wraps the managed hook command to survive spaces in the profile path (#6078)',
    () => {
      const spaceHome = join(tmpdir(), 'orca grok home with spaces')
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        expect(new GrokHookService().install().state).toBe('installed')

        const config = JSON.parse(
          readFileSync(join(spaceHome, '.grok', 'hooks', 'orca-status.json'), 'utf8')
        ) as { hooks: Record<string, { hooks: { command: string }[] }[]> }

        for (const eventName of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
          const command = config.hooks[eventName]?.[0]?.hooks?.[0]?.command
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        }
      } finally {
        rmSync(spaceHome, { recursive: true, force: true })
      }
    }
  )

  it('preserves user-authored hook entries in the Orca Grok config file', () => {
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          hooks: {
            Notification: [{ hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }] }]
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
    expect(
      commands.some((command) =>
        process.platform === 'win32'
          ? WINDOWS_POWERSHELL_LAUNCHER.test(command)
          : command.includes(GROK_SCRIPT_FILE_NAME)
      )
    ).toBe(true)
  })
})
