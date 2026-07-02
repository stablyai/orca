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

import { CursorHookService } from './hook-service'

const CURSOR_EVENTS = [
  'beforeSubmitPrompt',
  'stop',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'beforeMCPExecution',
  'afterAgentResponse'
]

const CURSOR_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'cursor-hook.cmd' : 'cursor-hook.sh'
const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/

describe('CursorHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-cursor-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
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
        rmSync(spaceHome, { recursive: true, force: true })
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
})
