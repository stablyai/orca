import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return { ...actual, homedir: homedirMock }
})

import { GeminiHookService } from './hook-service'

describe('GeminiHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-gemini-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('rewrites outdated Orca entries on script refresh but keeps ones the user disabled in Gemini', async () => {
    const configPath = join(homeDir, '.gemini', 'settings.json')
    mkdirSync(join(homeDir, '.gemini'), { recursive: true })
    const oldCommand = `old-wrapper ${join(homeDir, '.orca', 'agent-hooks', 'gemini-hook.sh')}`
    const disabledCommand = `disabled-wrapper ${join(homeDir, '.orca', 'agent-hooks', 'gemini-hook.sh')}`
    writeFileSync(
      configPath,
      JSON.stringify({
        hooksConfig: { disabled: [disabledCommand] },
        hooks: {
          AfterTool: [
            { hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }] },
            { hooks: [{ type: 'command', command: oldCommand }] }
          ],
          BeforeTool: [{ hooks: [{ type: 'command', command: disabledCommand }] }]
        }
      })
    )

    await new GeminiHookService().refreshManagedScripts()

    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(Object.keys(config.hooks).sort()).toEqual(['AfterTool', 'BeforeTool'])
    expect(config.hooks.AfterTool[0].hooks[0].command).toBe('/usr/local/bin/user-hook')
    const rewritten = config.hooks.AfterTool[1].hooks[0].command
    expect(rewritten).toContain('gemini-hook.')
    expect(rewritten).not.toBe(oldCommand)
    expect(config.hooks.BeforeTool).toEqual([
      { hooks: [{ type: 'command', command: disabledCommand }] }
    ])
  })
})
