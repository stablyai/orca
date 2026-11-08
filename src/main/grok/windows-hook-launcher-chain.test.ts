// Prefer one cmd-safe token to avoid Grok's extra pwsh wrapper; use encoded fallback for unsafe paths.
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

describe('Windows Grok managed hook launch shape', () => {
  // POSIX path.join cannot produce a real cmd-safe install path; synthetic Windows paths cover that branch everywhere.
  describe('registered command, from a synthetic Windows path', () => {
    const scriptPath = 'C:\\Users\\dev\\.orca\\agent-hooks\\grok-hook.cmd'

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
  })
})
