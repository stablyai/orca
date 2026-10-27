// Prefer one cmd-safe token to avoid Grok's extra pwsh wrapper; use encoded fallback for unsafe paths.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

import { getManagedCommandForTests, GrokHookService } from './hook-service'
import { wrapWindowsHookCommand, type HooksConfig } from '../agent-hooks/installer-utils'
import { buildInstalledGrokConfig } from './grok-hook-config'

const GROK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopCancelled',
  'StopFailure',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification'
] as const

type InstalledConfig = {
  hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
}

// Stub Windows so command-shape coverage runs on every CI platform.
function withWin32<T>(run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

function readInstalledConfig(home: string): InstalledConfig {
  return JSON.parse(
    readFileSync(join(home, '.grok', 'hooks', 'orca-status.json'), 'utf8')
  ) as InstalledConfig
}

function registeredCommands(config: InstalledConfig): string[] {
  return GROK_EVENT_NAMES.flatMap((eventName) =>
    (config.hooks[eventName] ?? []).flatMap((definition) =>
      definition.hooks.map((hook) => hook.command)
    )
  )
}

describe('Windows Grok managed hook launch shape', () => {
  // POSIX path.join cannot produce a real cmd-safe install path; synthetic Windows paths cover that branch everywhere.
  describe('registered command, from a synthetic Windows path', () => {
    const scriptPath = 'C:\\Users\\dev\\.orca\\agent-hooks\\grok-hook.cmd'

    it('registers a cmd-safe script path as the command itself (#14828)', () => {
      const command = withWin32(() => getManagedCommandForTests(scriptPath))

      // Grok needs one spawnable token; forward slashes survive Git Bash's backslash stripping.
      expect(command).toBe('C:/Users/dev/.orca/agent-hooks/grok-hook.cmd')
      // Any whitespace reintroduces Grok's pwsh wrapper.
      expect(command, 'a space would reintroduce the pwsh wrapper').not.toMatch(/\s/)
      expect(command).not.toMatch(/powershell|pwsh/i)
      expect(command).not.toMatch(/-EncodedCommand/i)
    })

    it('still wraps a path cmd.exe would split or expand (#6078)', () => {
      const spaced = 'C:\\Users\\Jane Doe\\.orca\\agent-hooks\\grok-hook.cmd'
      const command = withWin32(() => getManagedCommandForTests(spaced))

      expect(command).toMatch(/-EncodedCommand \S+$/)
      expect(command).not.toContain(spaced)
    })

    // Stub Windows so legacy hook cleanup also runs on POSIX CI.
    it('replaces a legacy backslash entry and keeps user hooks', () => {
      const config: HooksConfig = {
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: scriptPath }] },
            { hooks: [{ type: 'command', command: 'C:\\tools\\user-hook.cmd' }] }
          ]
        }
      }
      withWin32(() =>
        buildInstalledGrokConfig(config, getManagedCommandForTests(scriptPath), 'grok-hook.cmd')
      )

      const stop = config.hooks?.Stop?.flatMap((definition) =>
        (definition.hooks ?? []).map((hook) => hook.command)
      )
      expect(stop).toEqual([
        'C:\\tools\\user-hook.cmd',
        'C:/Users/dev/.orca/agent-hooks/grok-hook.cmd'
      ])
    })
  })

  describe('installed config', () => {
    let home = ''

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'orca-grok-launcher-'))
      homedirMock.mockReturnValue(home)
    })

    afterEach(() => {
      vi.clearAllMocks()
      rmSync(home, { recursive: true, force: true })
      home = ''
    })

    it.skipIf(process.platform !== 'win32')(
      'writes the generated script path itself to every managed event',
      () => {
        const scriptPath = join(home, '.orca', 'agent-hooks', 'grok-hook.cmd')
        const commands = withWin32(() => {
          expect(new GrokHookService().install().state).toBe('installed')
          return registeredCommands(readInstalledConfig(home))
        })

        expect(commands).toHaveLength(GROK_EVENT_NAMES.length)
        for (const command of commands) {
          expect(command).toBe(scriptPath.replaceAll('\\', '/'))
          expect(existsSync(command), 'registered command must name a real file').toBe(true)
        }
      }
    )

    it.skipIf(process.platform !== 'win32')(
      'replaces a previously installed encoded-PowerShell entry on reinstall',
      () => {
        const scriptPath = join(home, '.orca', 'agent-hooks', 'grok-hook.cmd')
        const staleCommand = wrapWindowsHookCommand(scriptPath)
        const configPath = join(home, '.grok', 'hooks', 'orca-status.json')
        mkdirSync(dirname(configPath), { recursive: true })
        writeFileSync(
          configPath,
          `${JSON.stringify({
            hooks: {
              Stop: [{ hooks: [{ type: 'command', command: staleCommand, timeout: 10 }] }],
              SubagentStop: [{ hooks: [{ type: 'command', command: staleCommand, timeout: 10 }] }],
              Notification: [{ hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }] }]
            }
          })}\n`,
          'utf8'
        )

        const config = withWin32(() => {
          expect(new GrokHookService().install().state).toBe('installed')
          return readInstalledConfig(home)
        })

        const all = Object.values(config.hooks).flatMap((definitions) =>
          definitions.flatMap((definition) => definition.hooks.map((hook) => hook.command))
        )
        expect(all).not.toContain(staleCommand)
        expect(all.filter((command) => /-EncodedCommand/i.test(command))).toEqual([])
        expect(config.hooks.SubagentStop).toBeUndefined()
        expect(all).toContain('/usr/local/bin/user-hook')
        expect(all.filter((command) => command === scriptPath.replaceAll('\\', '/'))).toHaveLength(
          GROK_EVENT_NAMES.length
        )
      }
    )

    it('falls back to the encoded launcher when the profile path is not cmd-safe (#6078)', () => {
      const spaceHome = mkdtempSync(join(tmpdir(), 'orca grok spaced '))
      homedirMock.mockReturnValue(spaceHome)
      try {
        const commands = withWin32(() => {
          expect(new GrokHookService().install().state).toBe('installed')
          return registeredCommands(readInstalledConfig(spaceHome))
        })

        expect(commands.length).toBeGreaterThan(0)
        for (const command of commands) {
          expect(command).toMatch(/-EncodedCommand \S+$/)
          expect(command).not.toContain(spaceHome)
        }
      } finally {
        rmSync(spaceHome, { recursive: true, force: true })
      }
    })
  })
})
