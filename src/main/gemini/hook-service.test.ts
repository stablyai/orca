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
                    command:
                      "if [ -x '/Users/ramzi/.orca/agent-hooks/gemini-hook.sh' ]; then /bin/sh '/Users/ramzi/.orca/agent-hooks/gemini-hook.sh'; fi"
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
    expect(Object.keys(config.hooks).sort()).toEqual(['AfterAgent', 'AfterTool', 'BeforeAgent'])
    expect(config.hooks.PreToolUse).toBeUndefined()
    expect(config.hooks.BeforeAgent).toHaveLength(2)
    expect(config.hooks.BeforeAgent[0].hooks[0].command).toBe('echo user-before-agent')
    expect(config.hooks.BeforeAgent[1].hooks[0].command).toContain('agent-hooks/gemini-hook.sh')
    expect(config.hooks.AfterAgent[0].hooks[0].command).toContain('agent-hooks/gemini-hook.sh')
    expect(config.hooks.AfterTool[0].hooks[0].command).toContain('agent-hooks/gemini-hook.sh')
  })
})
