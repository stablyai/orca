import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { DroidHookService } from './hook-service'

describe('DroidHookService', () => {
  let homeDir: string
  let userDataDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-droid-home-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-droid-user-data-'))
    homedirMock.mockReturnValue(homeDir)
    getPathMock.mockImplementation((name: string) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath(${name})`)
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('installs the managed command for Droid status events', () => {
    const status = new DroidHookService().install()

    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(readFileSync(join(homeDir, '.factory', 'settings.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    expect(Object.keys(config.hooks).sort()).toEqual(
      [
        'Notification',
        'PermissionRequest',
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'SubagentStop',
        'UserPromptSubmit'
      ].sort()
    )
    expect(config.hooks.PreToolUse[0].matcher).toBe('*')
    expect(config.hooks.PermissionRequest[0].matcher).toBe('*')
    expect(config.hooks.UserPromptSubmit[0].matcher).toBeUndefined()
    expect(config.hooks.PreToolUse[0].hooks[0].command).toMatch(
      process.platform === 'win32'
        ? /^powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/
        : /droid-hook/
    )
    if (process.platform !== 'win32') {
      expect(config.hooks.PreToolUse[0].hooks[0].command).toContain(join(homeDir, '.orca'))
    }
    expect(config.hooks.PreToolUse[0].hooks[0].command).not.toContain(userDataDir)
  })

  // Why: #6078 — a Windows user profile path with a space used to be written
  // verbatim as the hook command, so the agent split it at the space. The
  // managed command must use an encoded launcher so the path never appears raw
  // on the cmd.exe command line.
  it.skipIf(process.platform !== 'win32')(
    'wraps the managed hook command to survive spaces in the profile path (#6078)',
    () => {
      const spaceHome = join(tmpdir(), 'orca droid home with spaces')
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        expect(new DroidHookService().install().state).toBe('installed')

        const config = JSON.parse(
          readFileSync(join(spaceHome, '.factory', 'settings.json'), 'utf8')
        ) as { hooks: Record<string, { hooks: { command: string }[] }[]> }

        for (const eventName of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
          const command = config.hooks[eventName]?.[0]?.hooks?.[0]?.command
          expect(command).toMatch(
            /^powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/
          )
        }
      } finally {
        rmSync(spaceHome, { recursive: true, force: true })
      }
    }
  )

  it('reports partial when Factory has hooks disabled globally', () => {
    const configPath = join(homeDir, '.factory', 'settings.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify({ hooksDisabled: true }, null, 2)}\n`)

    const status = new DroidHookService().install()

    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toBe('Droid hooks are disabled in Factory settings')
  })
})
