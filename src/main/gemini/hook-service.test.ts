import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { wrapWindowsBatchHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'

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
        ? wrapWindowsBatchHookCommand(join(homeDir, '.orca', 'agent-hooks', managedHookFileName))
        : new RegExp(managedHookFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
  })
})
