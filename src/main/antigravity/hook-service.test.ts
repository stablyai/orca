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

import { AntigravityHookService } from './hook-service'

const ANTIGRAVITY_SCRIPT_FILE_NAME =
  process.platform === 'win32' ? 'antigravity-hook.cmd' : 'antigravity-hook.sh'
const ANTIGRAVITY_PRE_INVOCATION_COMMAND =
  process.platform === 'win32' ? 'antigravity-pre-invocation.cmd' : 'antigravity-hook.sh'
const ANTIGRAVITY_POST_TOOL_USE_COMMAND =
  process.platform === 'win32' ? 'antigravity-post-tool-use.cmd' : 'antigravity-hook.sh'

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

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
    expect(config['orca-status'].PreInvocation[0].command).toContain(
      ANTIGRAVITY_PRE_INVOCATION_COMMAND
    )
    if (process.platform === 'win32') {
      expect(config['orca-status'].PreInvocation[0].command).not.toContain('ORCA_ANTIGRAVITY_EVENT')
    } else {
      expect(config['orca-status'].PreInvocation[0].command).toContain(
        "ORCA_ANTIGRAVITY_EVENT='PreInvocation'"
      )
      expect(config['orca-status'].Stop[0].command).toContain("ORCA_ANTIGRAVITY_EVENT='Stop'")
    }

    const script = readFileSync(
      join(homeDir, '.orca', 'agent-hooks', ANTIGRAVITY_SCRIPT_FILE_NAME),
      'utf8'
    )
    expect(script).toContain('/hook/antigravity')
    if (process.platform === 'win32') {
      expect(script).toContain('%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(script).toContain('hook_event_name=$env:ORCA_ANTIGRAVITY_EVENT')
      expect(script).toContain('[string]::IsNullOrWhiteSpace($inputData)) { @{} }')
      expect(script).not.toContain('[string]::IsNullOrWhiteSpace($inputData)) { exit 0 }')
    } else {
      expect(script).toContain('hook_event_name=${ORCA_ANTIGRAVITY_EVENT}')
      expect(script).toContain('payload=$(cat)')
      expect(script).toContain("payload='{}'")
      expect(script).not.toContain('if [ -z "$payload" ]; then\n  exit 0\nfi')
    }
    expect(script).toContain('{"decision":""}')
  })

  it('installs Windows event wrappers without nested cmd quoting and removes stale PreToolUse hooks', () => {
    withPlatform('win32', () => {
      const configPath = join(homeDir, '.gemini', 'config', 'hooks.json')
      const staleScriptPath = join(
        homeDir,
        '.orca',
        'agent-hooks',
        'antigravity-hook.cmd'
      ).replaceAll('/', '\\')
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            'orca-status': {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: `cmd /d /s /c "set "ORCA_ANTIGRAVITY_EVENT=PreToolUse" && call "${staleScriptPath}""`
                    }
                  ]
                }
              ]
            }
          },
          null,
          2
        )}\n`
      )

      const service = new AntigravityHookService()
      const staleStatus = service.getStatus()
      expect(staleStatus.state).toBe('partial')
      expect(staleStatus.managedHooksPresent).toBe(true)

      const status = service.install()

      expect(status.state).toBe('installed')

      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        'orca-status': Record<
          string,
          { matcher?: string; command?: string; hooks?: { command: string }[] }[]
        >
      }
      expect(config['orca-status'].PreToolUse).toBeUndefined()

      const expectedWrappers = {
        PreInvocation: 'antigravity-pre-invocation.cmd',
        PostInvocation: 'antigravity-post-invocation.cmd',
        Stop: 'antigravity-stop.cmd',
        PostToolUse: 'antigravity-post-tool-use.cmd'
      }
      for (const [eventName, wrapperFileName] of Object.entries(expectedWrappers)) {
        const definition = config['orca-status'][eventName][0]
        const command =
          eventName === 'PostToolUse' ? definition.hooks?.[0]?.command : definition.command
        expect(command).toContain(wrapperFileName)
        expect(command).not.toContain('cmd /d /s /c')
        expect(command).not.toContain('ORCA_ANTIGRAVITY_EVENT')
        expect(command).not.toContain('"')

        const wrapper = readFileSync(join(homeDir, '.orca', 'agent-hooks', wrapperFileName), 'utf8')
        expect(wrapper).toContain(`set "ORCA_ANTIGRAVITY_EVENT=${eventName}"`)
        expect(wrapper).toContain('call "%ORCA_ANTIGRAVITY_CORE%"')
      }

      const script = readFileSync(
        join(homeDir, '.orca', 'agent-hooks', 'antigravity-hook.cmd'),
        'utf8'
      )
      expect(script).toContain('/hook/antigravity')
      expect(script).toContain('%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(script).toContain('hook_event_name=$env:ORCA_ANTIGRAVITY_EVENT')
      expect(script).toContain('[string]::IsNullOrWhiteSpace($inputData)) { @{} }')
      expect(script).not.toContain('[string]::IsNullOrWhiteSpace($inputData)) { exit 0 }')
    })
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
    expect(commands.some((command) => command.includes(ANTIGRAVITY_PRE_INVOCATION_COMMAND))).toBe(
      true
    )
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
    expect(commands[0]).toContain(
      join(homeDir, '.orca', 'agent-hooks', ANTIGRAVITY_POST_TOOL_USE_COMMAND)
    )
  })
})
