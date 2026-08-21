import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
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
import { POSIX_HOOK_STDIN_READER } from '../agent-hooks/hook-stdin-contract'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'

const ANTIGRAVITY_SCRIPT_FILE_NAME =
  process.platform === 'win32' ? 'antigravity-hook.cmd' : 'antigravity-hook.sh'
const ANTIGRAVITY_PRE_INVOCATION_COMMAND =
  process.platform === 'win32' ? 'antigravity-pre-invocation.cmd' : 'antigravity-hook.sh'
const ANTIGRAVITY_POST_TOOL_USE_COMMAND =
  process.platform === 'win32' ? 'antigravity-post-tool-use.cmd' : 'antigravity-hook.sh'
const ANTIGRAVITY_PRE_TOOL_USE_COMMAND =
  process.platform === 'win32' ? 'antigravity-pre-tool-use.cmd' : 'antigravity-hook.sh'
// Why: the gate decision MCode is allowed to emit — "allow" would auto-approve every observed tool call.
const PRE_TOOL_USE_DECISION = '{"decision":"ask"}'
const POLICY_OVERRIDING_DECISIONS = ['allow', 'deny', 'force_ask', 'deny_unless_prior_grant']

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
    homeDir = mkdtempSync(join(tmpdir(), 'mcode-antigravity-home-'))
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
      'mcode-status': Record<
        string,
        { matcher?: string; command?: string; hooks?: { command: string }[] }[]
      >
    }
    expect(Object.keys(config['mcode-status']).sort()).toEqual(
      ['PostInvocation', 'PostToolUse', 'PreInvocation', 'PreToolUse', 'Stop'].sort()
    )
    expect(config['mcode-status'].PreToolUse[0].matcher).toBe('*')
    expect(config['mcode-status'].PreToolUse[0].hooks?.[0]?.command).toContain(
      ANTIGRAVITY_PRE_TOOL_USE_COMMAND
    )
    expect(config['mcode-status'].PostToolUse[0].matcher).toBe('*')
    expect(config['mcode-status'].PreInvocation[0].command).toContain(
      ANTIGRAVITY_PRE_INVOCATION_COMMAND
    )
    if (process.platform === 'win32') {
      expect(config['mcode-status'].PreInvocation[0].command).not.toContain('MCODE_ANTIGRAVITY_EVENT')
    } else {
      expect(config['mcode-status'].PreInvocation[0].command).toContain(
        "MCODE_ANTIGRAVITY_EVENT='PreInvocation'"
      )
      expect(config['mcode-status'].Stop[0].command).toContain("MCODE_ANTIGRAVITY_EVENT='Stop'")
    }

    const script = readFileSync(
      join(homeDir, '.mcode', 'agent-hooks', ANTIGRAVITY_SCRIPT_FILE_NAME),
      'utf8'
    )
    expect(script).toContain('/hook/antigravity')
    if (process.platform === 'win32') {
      expect(script).not.toContain('powershell.exe')
      expect(script).toContain('%SystemRoot%\\System32\\curl.exe')
      expect(script).toContain('hook_event_name=%MCODE_ANTIGRAVITY_EVENT%')
      expect(script).toContain('--data-urlencode "payload@-"')
      // Why (#9358/#9941): delayed expansion eats `!` out of percent-expanded curl args.
      expect(script).toContain('setlocal DisableDelayedExpansion')
    } else {
      expect(script).toContain('hook_event_name=${MCODE_ANTIGRAVITY_EVENT}')
      expect(script).toContain(`payload=$(${POSIX_HOOK_STDIN_READER})`)
      expect(script).toContain("payload='{}'")
      expect(script).not.toContain('if [ -z "$payload" ]; then\n  exit 0\nfi')
      // Why: payload is piped to curl via stdin (`payload@-`) so it never lands
      // on the curl command line (EDR oversized-command-line false positive).
      expect(script).toContain('printf \'%s\' "$payload" | curl')
      expect(script).toContain('--data-urlencode "payload@-"')
      expect(script).not.toContain('--data-urlencode "payload=${payload}"')
    }
    expect(script).toContain('{"decision":""}')
    expect(script).toContain(PRE_TOOL_USE_DECISION)
    for (const decision of POLICY_OVERRIDING_DECISIONS) {
      expect(script).not.toContain(`{"decision":"${decision}"}`)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'answers the PreToolUse gate with ask so the hook never decides tool permissions',
    () => {
      new AntigravityHookService().install()

      const result = spawnSync(
        '/bin/sh',
        [join(homeDir, '.mcode', 'agent-hooks', 'antigravity-hook.sh')],
        {
          env: {
            ...process.env,
            MCODE_ANTIGRAVITY_EVENT: 'PreToolUse',
            MCODE_AGENT_HOOK_ENDPOINT: '',
            MCODE_AGENT_HOOK_PORT: '',
            MCODE_AGENT_HOOK_TOKEN: '',
            MCODE_PANE_KEY: ''
          },
          input: '{"toolCall":{"name":"run_command","args":{"CommandLine":"ls"}}}',
          encoding: 'utf8'
        }
      )

      expect(result.status).toBe(0)
      // Why: Antigravity reads silence/`{}` on PreToolUse as a deny (#2426), so the exact payload is the contract.
      expect(result.stdout).toBe(`${PRE_TOOL_USE_DECISION}\n`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps answering the PreToolUse gate when the managed script is missing',
    () => {
      new AntigravityHookService().install()
      rmSync(join(homeDir, '.mcode', 'agent-hooks'), { recursive: true, force: true })

      const config = JSON.parse(
        readFileSync(join(homeDir, '.gemini', 'config', 'hooks.json'), 'utf8')
      ) as { 'mcode-status': Record<string, { hooks?: { command: string }[] }[]> }
      const command = config['mcode-status'].PreToolUse[0].hooks?.[0]?.command

      const result = spawnSync('/bin/sh', ['-c', command!], {
        input: '{"toolCall":{"name":"run_command"}}',
        encoding: 'utf8'
      })

      // Why: hooks.json lives in ~/.gemini and outlives ~/.mcode, so a swept script must not deny every tool call.
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`${PRE_TOOL_USE_DECISION}\n`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'leaves non-gate Antigravity events silent when the managed script is missing',
    () => {
      new AntigravityHookService().install()
      rmSync(join(homeDir, '.mcode', 'agent-hooks'), { recursive: true, force: true })

      const config = JSON.parse(
        readFileSync(join(homeDir, '.gemini', 'config', 'hooks.json'), 'utf8')
      ) as {
        'mcode-status': Record<string, { command?: string; hooks?: { command: string }[] }[]>
      }
      const postToolUse = config['mcode-status'].PostToolUse[0].hooks?.[0]?.command
      const preInvocation = config['mcode-status'].PreInvocation[0].command

      for (const command of [postToolUse, preInvocation]) {
        const result = spawnSync('/bin/sh', ['-c', command!], { input: '{}', encoding: 'utf8' })
        expect(result.status).toBe(0)
        expect(result.stdout).toBe('')
      }
    }
  )

  it('installs Windows event wrappers without nested cmd quoting and replaces stale PreToolUse hooks', () => {
    withPlatform('win32', () => {
      const configPath = join(homeDir, '.gemini', 'config', 'hooks.json')
      const staleScriptPath = join(
        homeDir,
        '.mcode',
        'agent-hooks',
        'antigravity-hook.cmd'
      ).replaceAll('/', '\\')
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            'mcode-status': {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: `cmd /d /s /c "set "MCODE_ANTIGRAVITY_EVENT=PreToolUse" && call "${staleScriptPath}""`
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
        'mcode-status': Record<
          string,
          { matcher?: string; command?: string; hooks?: { command: string }[] }[]
        >
      }
      expect(config['mcode-status'].PreToolUse).toHaveLength(1)

      const expectedWrappers = {
        PreInvocation: 'antigravity-pre-invocation.cmd',
        PostInvocation: 'antigravity-post-invocation.cmd',
        Stop: 'antigravity-stop.cmd',
        PreToolUse: 'antigravity-pre-tool-use.cmd',
        PostToolUse: 'antigravity-post-tool-use.cmd'
      }
      for (const [eventName, wrapperFileName] of Object.entries(expectedWrappers)) {
        const definition = config['mcode-status'][eventName][0]
        const command = ['PreToolUse', 'PostToolUse'].includes(eventName)
          ? definition.hooks?.[0]?.command
          : definition.command
        expect(createManagedCommandMatcher(wrapperFileName)(command)).toBe(true)
        expect(command).not.toContain('cmd /d /s /c')
        expect(command).not.toContain('MCODE_ANTIGRAVITY_EVENT')

        const wrapper = readFileSync(join(homeDir, '.mcode', 'agent-hooks', wrapperFileName), 'utf8')
        expect(wrapper).toContain(`set "MCODE_ANTIGRAVITY_EVENT=${eventName}"`)
        expect(wrapper).toContain('call "%MCODE_ANTIGRAVITY_CORE%"')
        // Why: the wrapper is the stdin owner when the core script is gone, so it must answer the gate itself.
        if (eventName === 'PreToolUse') {
          expect(wrapper).toContain(`echo ${PRE_TOOL_USE_DECISION}`)
        }
        for (const decision of POLICY_OVERRIDING_DECISIONS) {
          expect(wrapper).not.toContain(`{"decision":"${decision}"}`)
        }
      }

      const script = readFileSync(
        join(homeDir, '.mcode', 'agent-hooks', 'antigravity-hook.cmd'),
        'utf8'
      )
      expect(script).toContain('/hook/antigravity')
      expect(script).not.toContain('powershell.exe')
      expect(script).toContain('%SystemRoot%\\System32\\curl.exe')
      expect(script).toContain('hook_event_name=%MCODE_ANTIGRAVITY_EVENT%')
      expect(script).toContain('setlocal DisableDelayedExpansion')
    })
  })

  it('preserves user-authored hook bundles and entries in MCode bundle', () => {
    const configPath = join(homeDir, '.gemini', 'config', 'hooks.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          'user-hook': {
            PreInvocation: [{ type: 'command', command: '/usr/local/bin/user-hook' }]
          },
          'mcode-status': {
            PreInvocation: [{ type: 'command', command: '/usr/local/bin/mcode-extra' }]
          }
        },
        null,
        2
      )}\n`
    )

    new AntigravityHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      'user-hook': { PreInvocation: { command: string }[] }
      'mcode-status': { PreInvocation: { command: string }[] }
    }
    expect(config['user-hook'].PreInvocation[0].command).toBe('/usr/local/bin/user-hook')
    const commands = config['mcode-status'].PreInvocation.map((entry) => entry.command)
    expect(commands).toContain('/usr/local/bin/mcode-extra')
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
          'mcode-status': {
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
      'mcode-status': Record<string, { command?: string; hooks?: { command: string }[] }[]>
    }
    expect(config['mcode-status'].OldEvent).toBeUndefined()
    // Why: the pre-a480e6b7 PreToolUse entry pointed at a script with no gate branch; it must be replaced, not kept.
    const preToolCommands = config['mcode-status'].PreToolUse.flatMap((definition) =>
      (definition.hooks ?? []).map((hook) => hook.command)
    )
    expect(preToolCommands).toHaveLength(1)
    expect(preToolCommands[0]).toContain(
      join(homeDir, '.mcode', 'agent-hooks', ANTIGRAVITY_PRE_TOOL_USE_COMMAND)
    )
    expect(preToolCommands[0]).not.toContain('/tmp/old/agent-hooks/antigravity-hook.sh')
    const commands = config['mcode-status'].PostToolUse.flatMap((definition) =>
      (definition.hooks ?? []).map((hook) => hook.command)
    )
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain(
      join(homeDir, '.mcode', 'agent-hooks', ANTIGRAVITY_POST_TOOL_USE_COMMAND)
    )
  })
})
