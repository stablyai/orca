import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type * as osModule from 'os'

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
    expect(config.hooks.BeforeAgent[1].hooks[0].command).toContain(managedHookPath)
    expect(config.hooks.AfterAgent[0].hooks[0].command).toContain(managedHookPath)
    expect(config.hooks.AfterTool[0].hooks[0].command).toContain(managedHookPath)
    expect(config.hooks.BeforeTool[0].hooks[0].command).toContain(managedHookPath)
  })

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
    expect(config.hooks.BeforeTool[0].hooks[0].command).toContain(managedHookFileName)
  })
})
