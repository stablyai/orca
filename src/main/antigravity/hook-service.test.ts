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

import { AntigravityHookService } from './hook-service'

describe('AntigravityHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-antigravity-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs Antigravity global hooks.json bundle and managed script', () => {
    const status = new AntigravityHookService().install()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(join(homeDir, '.gemini', 'config', 'hooks.json'))
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(
      readFileSync(join(homeDir, '.gemini', 'config', 'hooks.json'), 'utf8')
    ) as {
      'orca-status': Record<
        string,
        { matcher?: string; command?: string; hooks?: { command: string }[] }[]
      >
    }
    expect(Object.keys(config['orca-status']).sort()).toEqual(
      ['PostInvocation', 'PostToolUse', 'PreInvocation', 'Stop'].sort()
    )
    expect(config['orca-status'].PreToolUse).toBeUndefined()
    expect(config['orca-status'].PostToolUse[0].matcher).toBe('*')
    expect(config['orca-status'].PreInvocation[0].command).toContain('antigravity-hook')
    expect(config['orca-status'].PreInvocation[0].command).toContain(
      "ORCA_ANTIGRAVITY_EVENT='PreInvocation'"
    )
    expect(config['orca-status'].Stop[0].command).toContain("ORCA_ANTIGRAVITY_EVENT='Stop'")

    const script = readFileSync(
      join(homeDir, '.orca', 'agent-hooks', 'antigravity-hook.sh'),
      'utf8'
    )
    expect(script).toContain('/hook/antigravity')
    expect(script).toContain('hook_event_name=${ORCA_ANTIGRAVITY_EVENT}')
    expect(script).toContain('payload=$(cat)')
    expect(script).toContain('{"decision":""}')
  })

  it('preserves user-authored hook bundles and entries in Orca bundle', () => {
    const configPath = join(homeDir, '.gemini', 'config', 'hooks.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          'user-hook': {
            PreInvocation: [{ type: 'command', command: '/usr/local/bin/user-hook' }]
          },
          'orca-status': {
            PreInvocation: [{ type: 'command', command: '/usr/local/bin/orca-extra' }]
          }
        },
        null,
        2
      )}\n`
    )

    new AntigravityHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      'user-hook': { PreInvocation: { command: string }[] }
      'orca-status': { PreInvocation: { command: string }[] }
    }
    expect(config['user-hook'].PreInvocation[0].command).toBe('/usr/local/bin/user-hook')
    const commands = config['orca-status'].PreInvocation.map((entry) => entry.command)
    expect(commands).toContain('/usr/local/bin/orca-extra')
    expect(commands.some((command) => command.includes('antigravity-hook.sh'))).toBe(true)
  })

  it('removes stale managed Antigravity hook entries from retired events', () => {
    const configPath = join(homeDir, '.gemini', 'config', 'hooks.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          'orca-status': {
            OldEvent: [
              {
                type: 'command',
                command: '/tmp/old/agent-hooks/antigravity-hook.sh'
              }
            ],
            PreToolUse: [
              {
                matcher: '*',
                hooks: [{ type: 'command', command: '/tmp/old/agent-hooks/antigravity-hook.sh' }]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    )

    new AntigravityHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      'orca-status': Record<string, { command?: string; hooks?: { command: string }[] }[]>
    }
    expect(config['orca-status'].OldEvent).toBeUndefined()
    expect(config['orca-status'].PreToolUse).toBeUndefined()
    const commands = config['orca-status'].PostToolUse.flatMap((definition) =>
      (definition.hooks ?? []).map((hook) => hook.command)
    )
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain(join(homeDir, '.orca', 'agent-hooks', 'antigravity-hook.sh'))
  })
})
