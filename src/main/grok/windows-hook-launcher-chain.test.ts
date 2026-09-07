// Why (#14828): Grok runs a hook `command` containing a space as `pwsh -Command <cmd>`, so the
// encoded PowerShell launcher put two interpreters between the agent and the script —
// `grok.exe -> pwsh.exe -> powershell.exe -> cmd.exe` — and the console Grok allocates for a
// hook stays up for the whole chain. Measured against Grok 1.0.5's own dispatcher timing, the
// same script costs ~610ms behind the launcher and ~110ms as a bare path. These assertions pin
// the launch shape; the payload/exit-code contract stays covered by hook-service.test.ts.
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
import { wrapWindowsHookCommand } from '../agent-hooks/installer-utils'

const GROK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
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

// Why: generate under a mocked win32 so the POSIX CI legs guard this too (#15117).
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
  // Why: only `process.platform` can be mocked, not `path.join`, so an install on a POSIX
  // runner produces a `/`-separated path that is cmd-safe by no definition and routes to the
  // #6078 fallback by design. These synthetic-path cases carry the invariant on every CI leg;
  // the install-based ones below re-check it against a real generated path on Windows.
  describe('registered command, from a synthetic Windows path', () => {
    const scriptPath = 'C:\\Users\\dev\\.orca\\agent-hooks\\grok-hook.cmd'

    it('registers a cmd-safe script path as the command itself (#14828)', () => {
      const command = withWin32(() => getManagedCommandForTests(scriptPath))

      // Why (#8430): Grok spawns this as argv[0], so it must be exactly one spawnable token.
      expect(command).toBe(scriptPath)
      // Why: whitespace is the sole trigger for Grok's `pwsh -Command` wrapper, which is the
      // interpreter this fix removes. Assert the trigger, not just the absence of the name.
      expect(command, 'a space would reintroduce the pwsh wrapper').not.toMatch(/\s/)
      expect(command).not.toMatch(/powershell|pwsh/i)
      expect(command).not.toMatch(/-EncodedCommand/i)
    })

    it('still wraps a path cmd.exe would split or expand (#6078)', () => {
      const spaced = 'C:\\Users\\Jane Doe\\.orca\\agent-hooks\\grok-hook.cmd'
      const command = withWin32(() => getManagedCommandForTests(spaced))

      expect(command).toMatch(/-EncodedCommand \S+$/)
      // Why: the raw path must never reach a cmd.exe command line unquoted.
      expect(command).not.toContain(spaced)
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

    // win32-only: a real cmd-safe managed path needs backslashes; see the note above.
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
          expect(command).toBe(scriptPath)
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
              // Why: a retired event must be swept too, or the old launcher keeps firing there.
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
        // Why: sweeping stale Orca entries must not touch hooks the user wrote.
        expect(all).toContain('/usr/local/bin/user-hook')
        expect(all.filter((command) => command === scriptPath)).toHaveLength(
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
