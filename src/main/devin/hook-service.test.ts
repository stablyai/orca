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

describe('DevinHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-devin-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs global Devin hooks and managed script', () => {
    const status = new DevinHookService().install()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(join(homeDir, '.config', 'devin', 'config.json'))
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(
      readFileSync(join(homeDir, '.config', 'devin', 'config.json'), 'utf8')
    ) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>
    }
    expect(Object.keys(config.hooks).sort()).toEqual(
      [
        'PermissionRequest',
        'PostToolUse',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit'
      ].sort()
    )
    expect(config.hooks.PreToolUse[0].matcher).toBe('')
    expect(config.hooks.SessionStart[0].matcher).toBeUndefined()
    expect(config.hooks.PreToolUse[0].hooks[0].timeout).toBe(2)
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain('devin-hook')
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain(join(homeDir, '.orca'))

    const script = readFileSync(join(homeDir, '.orca', 'agent-hooks', 'devin-hook.sh'), 'utf8')
    expect(script).toContain('/hook/devin')
    expect(script).toContain('payload=$(cat)')
  })

  it('preserves user-authored Devin hook entries while installing managed hooks', () => {
    const configPath = join(homeDir, '.config', 'devin', 'config.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }] }]
          }
        },
        null,
        2
      )}\n`
    )

    new DevinHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const commands = config.hooks.SessionStart.flatMap((definition) =>
      definition.hooks.map((hook) => hook.command)
    )
    expect(commands).toContain('/usr/local/bin/user-hook')
    expect(commands.some((command) => command.includes('devin-hook.sh'))).toBe(true)
  })
})
