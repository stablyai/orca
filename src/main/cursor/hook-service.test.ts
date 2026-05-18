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
      expect(definition?.command).toContain('cursor-hook')
      expect(definition?.command).toContain(join(homeDir, '.orca'))
      expect(definition?.hooks).toBeUndefined()
    }

    const script = readFileSync(join(homeDir, '.orca', 'agent-hooks', 'cursor-hook.sh'), 'utf8')
    expect(script).toContain('/hook/cursor')
    expect(script).toContain('payload=$(cat)')
  })

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
    expect(promptCommands.filter((command) => command?.includes('cursor-hook.sh'))).toHaveLength(1)
    expect(config.hooks.retiredEvent.map((definition) => definition.command)).toEqual([
      '/usr/local/bin/retired-user-hook'
    ])
  })
})
