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

import { GrokHookService } from './hook-service'

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
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain('grok-hook')
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain(join(homeDir, '.orca'))

    const script = readFileSync(join(homeDir, '.orca', 'agent-hooks', 'grok-hook.sh'), 'utf8')
    expect(script).toContain('/hook/grok')
    expect(script).toContain('payload=$(cat)')
  })

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
    expect(commands.some((command) => command.includes('grok-hook.sh'))).toBe(true)
  })
})
