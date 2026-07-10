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

import { getGrokToolEventMatcherForTests, GrokHookService } from './hook-service'

const GROK_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'grok-hook.cmd' : 'grok-hook.sh'
const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/

describe('GrokHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-grok-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs a dedicated global Grok hook config and managed script', () => {
    const status = new GrokHookService().install()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(join(homeDir, '.grok', 'hooks', 'orca-status.json'))
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(
      readFileSync(join(homeDir, '.grok', 'hooks', 'orca-status.json'), 'utf8')
    ) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    expect(Object.keys(config.hooks).sort()).toEqual(
      [
        'Notification',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'StopFailure',
        'UserPromptSubmit'
      ].sort()
    )
    // Why: Grok matchers are real regexes; bare `*` does not match-all.
    expect(config.hooks.PreToolUse[0].matcher).toBe('.*')
    expect(config.hooks.PostToolUseFailure[0].matcher).toBe('.*')
    expect(config.hooks.PostToolUse[0].matcher).toBe('.*')
    // Why: StopFailure must not carry a tool matcher — lifecycle-only event.
    expect(config.hooks.StopFailure[0].matcher).toBeUndefined()
    expect(config.hooks.Notification[0].matcher).toBeUndefined()
    // Why: assert the shipped helper still matches what install wrote (regression
    // guard if GROK_TOOL_EVENT_MATCHER drifts from install).
    expect(getGrokToolEventMatcherForTests()).toBe('.*')
    expect(getGrokToolEventMatcherForTests()).not.toBe('*')
    expect(new RegExp(getGrokToolEventMatcherForTests()).test('run_terminal_command')).toBe(true)
    // Why: build the invalid pattern at runtime so static lint does not flag it.
    const bareStar = ['*', ''].join('')
    expect(() => new RegExp(bareStar)).toThrow()
    expect(config.hooks.PreToolUse[0].hooks[0].command).toMatch(
      process.platform === 'win32' ? WINDOWS_POWERSHELL_LAUNCHER : /grok-hook/
    )
    if (process.platform !== 'win32') {
      expect(config.hooks.PreToolUse[0].hooks[0].command).toContain(join(homeDir, '.orca'))
    }

    const script = readFileSync(
      join(homeDir, '.orca', 'agent-hooks', GROK_SCRIPT_FILE_NAME),
      'utf8'
    )
    expect(script).toContain('/hook/grok')
    if (process.platform === 'win32') {
      expect(script).toContain('%SystemRoot%\\System32\\curl.exe')
      expect(script).toContain('set "ORCA_GROK_HOME=%GROK_HOME%"')
      expect(script).toContain('%GROK_HOME:~4096,1%')
      expect(script).toContain(
        'if "%ORCA_GROK_HOME:~-1%"=="\\" set "ORCA_GROK_HOME=%ORCA_GROK_HOME%."'
      )
      expect(script).toContain('--data-urlencode "grokHome=%ORCA_GROK_HOME%"')
    } else {
      // Why: payload is piped to curl via stdin (`payload@-`) so it never lands
      // on the curl command line (EDR oversized-command-line false positive).
      expect(script).toContain('payload=$(cat)')
      expect(script).toContain('printf \'%s\' "$payload" | curl')
      expect(script).toContain('--data-urlencode "payload@-"')
      expect(script).toContain('${#GROK_HOME}" -le 4096')
      expect(script).toContain('--data-urlencode "grokHome=${grok_home}"')
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
      const spaceHome = join(tmpdir(), 'orca grok home with spaces')
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        expect(new GrokHookService().install().state).toBe('installed')

        const config = JSON.parse(
          readFileSync(join(spaceHome, '.grok', 'hooks', 'orca-status.json'), 'utf8')
        ) as { hooks: Record<string, { hooks: { command: string }[] }[]> }

        for (const eventName of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
          const command = config.hooks[eventName]?.[0]?.hooks?.[0]?.command
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        }
      } finally {
        rmSync(spaceHome, { recursive: true, force: true })
      }
    }
  )

  it('installs hooks under GROK_HOME when set', () => {
    const grokHome = mkdtempSync(join(tmpdir(), 'orca-grok-home-env-'))
    const previous = process.env.GROK_HOME
    process.env.GROK_HOME = grokHome
    try {
      const status = new GrokHookService().install()
      expect(status.state).toBe('installed')
      expect(status.configPath).toBe(join(grokHome, 'hooks', 'orca-status.json'))
      expect(readFileSync(join(grokHome, 'hooks', 'orca-status.json'), 'utf8')).toContain(
        'SessionStart'
      )
      // Why: must not also write into the mocked ~/.grok when GROK_HOME wins.
      expect(() =>
        readFileSync(join(homeDir, '.grok', 'hooks', 'orca-status.json'), 'utf8')
      ).toThrow()
    } finally {
      if (previous === undefined) {
        delete process.env.GROK_HOME
      } else {
        process.env.GROK_HOME = previous
      }
      rmSync(grokHome, { recursive: true, force: true })
    }
  })

  it('preserves user-authored hook entries in the Orca Grok config file', () => {
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          hooks: {
            Notification: [{ hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }] }]
          }
        },
        null,
        2
      )}\n`
    )

    new GrokHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const commands = config.hooks.Notification.flatMap((definition) =>
      definition.hooks.map((hook) => hook.command)
    )
    expect(commands).toContain('/usr/local/bin/user-hook')
    expect(
      commands.some((command) =>
        process.platform === 'win32'
          ? WINDOWS_POWERSHELL_LAUNCHER.test(command)
          : command.includes(GROK_SCRIPT_FILE_NAME)
      )
    ).toBe(true)
  })
})
