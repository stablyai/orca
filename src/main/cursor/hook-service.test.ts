import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { findGitBash } from '../agent-hooks/windows-git-bash-path.test-fixture'

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

import { CursorHookService } from './hook-service'
import { POSIX_HOOK_STDIN_READER } from '../agent-hooks/hook-stdin-contract'
import { CURSOR_EVENTS, type CursorEvent } from './hook-events'

const CURSOR_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'cursor-hook.cmd' : 'cursor-hook.sh'
const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -EncodedCommand \S+$/

// Why: on Windows one hook run is cmd.exe -> powershell.exe -> cmd.exe -> cursor-hook.cmd ->
// curl.exe, and the package job runs ~25 files at maxWorkers 4 alongside real-Electron and
// node-pty suites, so a cold CLR start competes for the runner. Deliberately above the product's
// own MANAGED_HOOK_TIMEOUT_SECONDS (10s): this gates launcher correctness, not user latency.
const HOOK_RUN_TIMEOUT_MS = 30_000
// Why: these cases run up to 16 of those chains back to back. Matches the same budget
// windows-hook-payload-delivery.test.ts uses for the identical chain.
const HOOK_CASE_TIMEOUT_MS = 60_000

type InstalledCursorHooks = {
  hooks: Record<string, { command?: string }[]>
}

const EXPECTED_CURSOR_HOOK_STDOUT = {
  beforeSubmitPrompt: { continue: true },
  stop: {},
  preToolUse: { permission: 'allow' },
  postToolUse: {},
  postToolUseFailure: {},
  beforeShellExecution: { permission: 'allow' },
  beforeMCPExecution: { permission: 'allow' },
  afterAgentResponse: {}
} satisfies Record<CursorEvent, Record<string, unknown>>

function readInstalledCursorHooks(homeDir: string): InstalledCursorHooks {
  return JSON.parse(
    readFileSync(join(homeDir, '.cursor', 'hooks.json'), 'utf8')
  ) as InstalledCursorHooks
}

function requireRegisteredCommand(config: InstalledCursorHooks, eventName: string): string {
  const command = config.hooks[eventName]?.[0]?.command
  expect(command, eventName).toEqual(expect.any(String))
  if (typeof command !== 'string') {
    throw new Error(`missing Cursor hook command for ${eventName}`)
  }
  return command
}

function runRegisteredCursorHook(
  command: string,
  input: string,
  extraEnv: NodeJS.ProcessEnv = {}
): { stdout: string; stderr: string; status: number | null } {
  const executable = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    input,
    timeout: HOOK_RUN_TIMEOUT_MS,
    env: {
      ...process.env,
      ORCA_AGENT_HOOK_ENDPOINT: '',
      ORCA_AGENT_HOOK_PORT: '',
      ORCA_AGENT_HOOK_TOKEN: '',
      ORCA_PANE_KEY: '',
      ...extraEnv
    }
  })
  expect(result.error, result.stderr).toBeUndefined()
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe('CursorHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-cursor-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    removeTreeSync(homeDir)
  })

  it('installs Cursor Agent hooks with the documented top-level command schema', () => {
    const status = new CursorHookService().install()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(join(homeDir, '.cursor', 'hooks.json'))
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(readFileSync(join(homeDir, '.cursor', 'hooks.json'), 'utf8')) as {
      version?: number
      hooks: Record<string, { command?: string; hooks?: unknown[] }[]>
    }
    expect(config.version).toBe(1)
    expect(Object.keys(config.hooks).sort()).toEqual([...CURSOR_EVENTS].sort())
    for (const eventName of CURSOR_EVENTS) {
      const definition = config.hooks[eventName]?.[0]
      expect(definition?.command).toMatch(
        process.platform === 'win32' ? WINDOWS_POWERSHELL_LAUNCHER : /cursor-hook/
      )
      if (process.platform !== 'win32') {
        expect(definition?.command).toContain(join(homeDir, '.orca'))
      }
      expect(definition?.hooks).toBeUndefined()
    }

    const script = readFileSync(
      join(homeDir, '.orca', 'agent-hooks', CURSOR_SCRIPT_FILE_NAME),
      'utf8'
    )
    expect(script).toContain('/hook/cursor')
    if (process.platform === 'win32') {
      expect(script).toContain('%SystemRoot%\\System32\\curl.exe')
    } else {
      // Why: payload is piped to curl via stdin (`payload@-`) so it never lands
      // on the curl command line (EDR oversized-command-line false positive).
      expect(script).toContain(`payload=$(${POSIX_HOOK_STDIN_READER})`)
      expect(script).toContain('printf \'%s\' "$payload" | curl')
      expect(script).toContain('--data-urlencode "payload@-"')
      expect(script).not.toContain('--data-urlencode "payload=${payload}"')
    }
  })

  // Why: #6078 — a Windows user profile path with a space used to be written
  // verbatim as the hook command, so the agent split it at the space. The
  // managed command must use an encoded launcher so the path never appears raw
  // on the cmd.exe command line.
  it.skipIf(process.platform !== 'win32')(
    'wraps the managed hook command to survive spaces in the profile path (#6078)',
    () => {
      const spaceHome = join(tmpdir(), 'orca cursor home with spaces')
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        expect(new CursorHookService().install().state).toBe('installed')

        const config = JSON.parse(
          readFileSync(join(spaceHome, '.cursor', 'hooks.json'), 'utf8')
        ) as { hooks: Record<string, { command?: string }[]> }

        for (const eventName of ['beforeSubmitPrompt', 'stop']) {
          const command = config.hooks[eventName]?.[0]?.command
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        }
      } finally {
        removeTreeSync(spaceHome)
      }
    }
  )

  it('preserves user-authored Cursor hook entries and removes stale managed entries', () => {
    const configPath = join(homeDir, '.cursor', 'hooks.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            beforeSubmitPrompt: [
              { command: '/usr/local/bin/user-hook' },
              { command: '/old/path/.orca/agent-hooks/cursor-hook.sh' }
            ],
            retiredEvent: [
              { command: '/old/path/.orca/agent-hooks/cursor-hook.sh' },
              { command: '/usr/local/bin/retired-user-hook' }
            ]
          }
        },
        null,
        2
      )}\n`
    )

    new CursorHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: Record<string, { command?: string }[]>
    }
    const promptCommands = config.hooks.beforeSubmitPrompt.map((definition) => definition.command)
    expect(promptCommands).toContain('/usr/local/bin/user-hook')
    expect(
      promptCommands.filter((command) =>
        process.platform === 'win32'
          ? command !== undefined && WINDOWS_POWERSHELL_LAUNCHER.test(command)
          : command?.includes(CURSOR_SCRIPT_FILE_NAME)
      )
    ).toHaveLength(1)
    expect(config.hooks.retiredEvent.map((definition) => definition.command)).toEqual([
      '/usr/local/bin/retired-user-hook'
    ])
  })

  // Why: installer-intent assertions missed empty stdout, which Cursor treats as
  // invalid JSON and fails closed (#15462). This runs the registered command.
  it(
    'emits protocol-valid JSON on stdout for every managed event, including empty stdin (#15462)',
    () => {
      expect(new CursorHookService().install().state).toBe('installed')
      const config = readInstalledCursorHooks(homeDir)
      const payloads = [
        (eventName: string) => JSON.stringify({ hook_event_name: eventName, tool_name: 'Write' }),
        () => ''
      ]

      for (const eventName of CURSOR_EVENTS) {
        const command = requireRegisteredCommand(config, eventName)
        for (const payloadFor of payloads) {
          const result = runRegisteredCursorHook(command, payloadFor(eventName))
          expect(result.status, `${eventName} exit`).toBe(0)
          expect(result.stderr, `${eventName} stderr`).toBe('')
          expect(JSON.parse(result.stdout), `${eventName} stdout`).toEqual(
            EXPECTED_CURSOR_HOOK_STDOUT[eventName]
          )
        }
      }
    },
    HOOK_CASE_TIMEOUT_MS
  )

  it(
    'emits protocol-valid JSON when the managed Cursor script is missing (#15462)',
    () => {
      expect(new CursorHookService().install().state).toBe('installed')
      const config = readInstalledCursorHooks(homeDir)
      unlinkSync(join(homeDir, '.orca', 'agent-hooks', CURSOR_SCRIPT_FILE_NAME))

      for (const eventName of CURSOR_EVENTS) {
        const command = requireRegisteredCommand(config, eventName)
        const result = runRegisteredCursorHook(command, '')
        expect(result.status, `${eventName} missing-script exit`).toBe(0)
        expect(result.stderr, `${eventName} missing-script stderr`).toBe('')
        expect(JSON.parse(result.stdout), `${eventName} missing-script stdout`).toEqual(
          EXPECTED_CURSOR_HOOK_STDOUT[eventName]
        )
      }
    },
    HOOK_CASE_TIMEOUT_MS
  )

  it(
    'keeps curl failure off stdout when the listener is unreachable (#15462)',
    () => {
      expect(new CursorHookService().install().state).toBe('installed')
      const config = readInstalledCursorHooks(homeDir)

      for (const eventName of ['beforeSubmitPrompt', 'preToolUse', 'stop'] as const) {
        const command = requireRegisteredCommand(config, eventName)
        const result = runRegisteredCursorHook(
          command,
          JSON.stringify({ hook_event_name: eventName, tool_name: 'Write' }),
          {
            ORCA_AGENT_HOOK_PORT: '59999',
            ORCA_AGENT_HOOK_TOKEN: 'token',
            ORCA_PANE_KEY: 'tab:leaf'
          }
        )
        expect(result.status, `${eventName} dead-listener exit`).toBe(0)
        expect(JSON.parse(result.stdout), `${eventName} dead-listener stdout`).toEqual(
          EXPECTED_CURSOR_HOOK_STDOUT[eventName]
        )
      }
    },
    HOOK_CASE_TIMEOUT_MS
  )

  it.skipIf(process.platform !== 'win32')(
    'emits parseable JSON through cmd.exe and Git Bash (#14825/#15462)',
    () => {
      expect(new CursorHookService().install().state).toBe('installed')
      const config = readInstalledCursorHooks(homeDir)
      const gitBash = findGitBash()
      const shells = [
        { name: 'cmd.exe', executable: 'cmd.exe', args: ['/d', '/c'] },
        { name: 'Git Bash', executable: gitBash, args: ['-c'] }
      ]
      for (const eventName of ['beforeSubmitPrompt', 'preToolUse'] as const) {
        const command = requireRegisteredCommand(config, eventName)
        for (const shell of shells) {
          const result = spawnSync(shell.executable, [...shell.args, command], {
            encoding: 'utf8',
            input: JSON.stringify({ hook_event_name: eventName, tool_name: 'Write' }),
            timeout: HOOK_RUN_TIMEOUT_MS,
            env: {
              ...process.env,
              ORCA_AGENT_HOOK_ENDPOINT: '',
              ORCA_AGENT_HOOK_PORT: '',
              ORCA_AGENT_HOOK_TOKEN: '',
              ORCA_PANE_KEY: '',
              USERPROFILE: homeDir
            }
          })
          expect(result.error, `${eventName} ${shell.name}`).toBeUndefined()
          expect(result.status, `${eventName} ${shell.name} exit`).toBe(0)
          expect(result.stderr, `${eventName} ${shell.name} stderr`).toBe('')
          expect(JSON.parse(result.stdout), `${eventName} ${shell.name} stdout`).toEqual(
            EXPECTED_CURSOR_HOOK_STDOUT[eventName]
          )
        }
      }
    },
    HOOK_CASE_TIMEOUT_MS
  )
})
