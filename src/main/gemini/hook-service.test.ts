import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type * as osModule from 'node:os'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { GeminiHookService } from './hook-service'

const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/

describe('GeminiHookService', () => {
  let homeDir: string
  let userDataDir: string

  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-gemini-home-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-gemini-userdata-'))
    homedirMock.mockReturnValue(homeDir)
    getPathMock.mockImplementation((name: string) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath(${name})`)
    })
  })

  afterAll(() => {
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('removes stale PreToolUse hooks when reinstalling managed Gemini hooks', () => {
    const managedHookFileName = process.platform === 'win32' ? 'gemini-hook.cmd' : 'gemini-hook.sh'
    const staleManagedHookPath =
      process.platform === 'win32'
        ? `C:\\Users\\ramzi\\.orca\\agent-hooks\\${managedHookFileName}`
        : `/Users/ramzi/.orca/agent-hooks/${managedHookFileName}`
    const staleManagedCommand =
      process.platform === 'win32'
        ? staleManagedHookPath
        : `if [ -x '${staleManagedHookPath}' ]; then /bin/sh '${staleManagedHookPath}'; fi`
    const managedHookPath = join(homeDir, '.orca', 'agent-hooks', managedHookFileName)
    const configDir = join(homeDir, '.gemini')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            BeforeAgent: [
              {
                hooks: [{ type: 'command', command: 'echo user-before-agent' }]
              }
            ],
            PreToolUse: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: staleManagedCommand
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      )
    )

    const service = new GeminiHookService()
    const status = service.install()
    const config = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))

    expect(status.state).toBe('installed')
    expect(Object.keys(config.hooks).sort()).toEqual([
      'AfterAgent',
      'AfterTool',
      'BeforeAgent',
      'BeforeTool'
    ])
    expect(config.hooks.PreToolUse).toBeUndefined()
    expect(config.hooks.BeforeAgent).toHaveLength(2)
    expect(config.hooks.BeforeAgent[0].hooks[0].command).toBe('echo user-before-agent')
    const managedCommandPattern =
      process.platform === 'win32'
        ? WINDOWS_POWERSHELL_LAUNCHER
        : new RegExp(managedHookPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    expect(config.hooks.BeforeAgent[1].hooks[0].command).toMatch(managedCommandPattern)
    expect(config.hooks.AfterAgent[0].hooks[0].command).toMatch(managedCommandPattern)
    expect(config.hooks.AfterTool[0].hooks[0].command).toMatch(managedCommandPattern)
    expect(config.hooks.BeforeTool[0].hooks[0].command).toMatch(managedCommandPattern)
  })

  // Why: #6078 — a Windows user profile path with a space used to be written
  // verbatim as the hook command, so the agent split it at the space. The
  // managed command must use an encoded launcher so the path never appears raw
  // on the cmd.exe command line.
  it.skipIf(process.platform !== 'win32')(
    'wraps the managed hook command to survive spaces in the profile path (#6078)',
    () => {
      const spaceHome = join(tmpdir(), 'orca gemini home with spaces')
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        expect(new GeminiHookService().install().state).toBe('installed')

        const config = JSON.parse(
          readFileSync(join(spaceHome, '.gemini', 'settings.json'), 'utf8')
        ) as { hooks: Record<string, { hooks: { command: string }[] }[]> }

        for (const eventName of ['BeforeAgent', 'AfterAgent', 'AfterTool']) {
          const command = config.hooks[eventName]?.[0]?.hooks?.[0]?.command
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        }
      } finally {
        rmSync(spaceHome, { recursive: true, force: true })
        homedirMock.mockReturnValue(homeDir)
      }
    }
  )

  it('preserves user-authored PreToolUse hooks while sweeping stale managed Gemini hooks', () => {
    const managedHookFileName = process.platform === 'win32' ? 'gemini-hook.cmd' : 'gemini-hook.sh'
    const staleManagedHookPath =
      process.platform === 'win32'
        ? `C:\\Users\\ramzi\\.orca\\agent-hooks\\${managedHookFileName}`
        : `/Users/ramzi/.orca/agent-hooks/${managedHookFileName}`
    const staleManagedCommand =
      process.platform === 'win32'
        ? staleManagedHookPath
        : `if [ -x '${staleManagedHookPath}' ]; then /bin/sh '${staleManagedHookPath}'; fi`
    const configDir = join(homeDir, '.gemini')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                hooks: [{ type: 'command', command: staleManagedCommand }]
              },
              {
                hooks: [{ type: 'command', command: 'echo user-authored' }]
              }
            ]
          }
        },
        null,
        2
      )
    )

    const status = new GeminiHookService().install()
    const config = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
    const preToolCommands = config.hooks.PreToolUse.flatMap(
      (definition: { hooks?: { command: string }[] }) =>
        (definition.hooks ?? []).map((hook) => hook.command)
    )

    expect(status.state).toBe('installed')
    expect(preToolCommands).toEqual(['echo user-authored'])
    expect(config.hooks.BeforeTool[0].hooks[0].command).toMatch(
      process.platform === 'win32'
        ? WINDOWS_POWERSHELL_LAUNCHER
        : new RegExp(managedHookFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
  })

  // Why: remove() must be a strict no-op when Orca never installed anything — it
  // must not create ~/.gemini (or settings.json), and must not rewrite/reformat
  // (or .bak-roll) a user settings.json that holds no managed hooks. A fresh
  // temp home is used since the outer suite shares one polluted home.
  it('remove() does not create settings.json or the config dir when nothing was installed', () => {
    const noopHome = mkdtempSync(join(tmpdir(), 'orca-gemini-remove-noop-'))
    homedirMock.mockReturnValue(noopHome)
    try {
      const status = new GeminiHookService().remove()
      expect(status.state).toBe('not_installed')
      expect(existsSync(join(noopHome, '.gemini'))).toBe(false)
    } finally {
      rmSync(noopHome, { recursive: true, force: true })
      homedirMock.mockReturnValue(homeDir)
    }
  })

  it('remove() leaves a user settings file byte-identical when it holds no managed hooks', () => {
    const noopHome = mkdtempSync(join(tmpdir(), 'orca-gemini-remove-user-'))
    homedirMock.mockReturnValue(noopHome)
    try {
      const settingsPath = join(noopHome, '.gemini', 'settings.json')
      mkdirSync(dirname(settingsPath), { recursive: true })
      // Deliberately NOT Orca's serialization: tabs, no trailing newline.
      const userContent =
        '{\n\t"hooks": {"BeforeAgent": [{"hooks": [{"type": "command", "command": "echo hi"}]}]}}'
      writeFileSync(settingsPath, userContent)

      const status = new GeminiHookService().remove()

      expect(status.state).toBe('not_installed')
      expect(readFileSync(settingsPath, 'utf-8')).toBe(userContent)
      expect(existsSync(`${settingsPath}.bak`)).toBe(false)
    } finally {
      rmSync(noopHome, { recursive: true, force: true })
      homedirMock.mockReturnValue(homeDir)
    }
  })

  it('remove() strips managed hooks and keeps user entries when Orca did install', () => {
    const noopHome = mkdtempSync(join(tmpdir(), 'orca-gemini-remove-installed-'))
    homedirMock.mockReturnValue(noopHome)
    try {
      const settingsPath = join(noopHome, '.gemini', 'settings.json')
      mkdirSync(dirname(settingsPath), { recursive: true })
      writeFileSync(
        settingsPath,
        `${JSON.stringify(
          { hooks: { BeforeAgent: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } },
          null,
          2
        )}\n`
      )
      const service = new GeminiHookService()
      expect(service.install().state).toBe('installed')

      const status = service.remove()

      expect(status.state).toBe('not_installed')
      const config = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        hooks: Record<string, { hooks?: { command: string }[] }[]>
      }
      const commands = Object.values(config.hooks).flatMap((definitions) =>
        definitions.flatMap((definition) => (definition.hooks ?? []).map((hook) => hook.command))
      )
      expect(commands).toEqual(['echo user'])
    } finally {
      rmSync(noopHome, { recursive: true, force: true })
      homedirMock.mockReturnValue(homeDir)
    }
  })
})
