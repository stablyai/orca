import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

// Why: mock the exact specifier the cleanup imports; vitest keys mocks by specifier.
vi.mock('node:os', async () => {
  const actual = (await vi.importActual('node:os')) as Record<string, unknown>
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { removeRetiredGeminiManagedHooksLocal } from './retired-gemini-hook-cleanup'

describe('removeRetiredGeminiManagedHooksLocal', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-gemini-hook-cleanup-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('removes managed gemini-hook commands and deletes the managed script', () => {
    const settingsDir = join(homeDir, '.gemini')
    const hooksDir = join(homeDir, '.orca', 'agent-hooks')
    mkdirSync(settingsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })
    const scriptPath = join(hooksDir, 'gemini-hook.sh')
    writeFileSync(scriptPath, '#!/bin/sh\nprintf "{}\\n"\n', 'utf8')
    writeFileSync(
      join(settingsDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          BeforeAgent: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `/bin/sh '${scriptPath}'`
                }
              ]
            },
            {
              hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }]
            }
          ],
          AfterTool: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `if [ -f '${scriptPath}' ]; then /bin/sh '${scriptPath}'; fi`
                }
              ]
            }
          ]
        },
        theme: 'dark'
      }),
      'utf8'
    )

    removeRetiredGeminiManagedHooksLocal()

    const settings = JSON.parse(readFileSync(join(settingsDir, 'settings.json'), 'utf8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
      theme: string
    }
    expect(settings.theme).toBe('dark')
    expect(settings.hooks.AfterTool).toBeUndefined()
    expect(settings.hooks.BeforeAgent).toEqual([
      { hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }] }
    ])
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('deletes the Windows script variants the command matcher also strips', () => {
    const hooksDir = join(homeDir, '.orca', 'agent-hooks')
    mkdirSync(hooksDir, { recursive: true })
    for (const fileName of ['gemini-hook.sh', 'gemini-hook.cmd', 'gemini-hook.ps1']) {
      writeFileSync(join(hooksDir, fileName), 'noop', 'utf8')
    }
    writeFileSync(join(hooksDir, 'claude-hook.ps1'), 'keep', 'utf8')

    removeRetiredGeminiManagedHooksLocal()

    expect(existsSync(join(hooksDir, 'gemini-hook.sh'))).toBe(false)
    expect(existsSync(join(hooksDir, 'gemini-hook.cmd'))).toBe(false)
    expect(existsSync(join(hooksDir, 'gemini-hook.ps1'))).toBe(false)
    expect(existsSync(join(hooksDir, 'claude-hook.ps1'))).toBe(true)
  })

  it('is a no-op when no managed gemini hooks are present', () => {
    const settingsDir = join(homeDir, '.gemini')
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(
      join(settingsDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          BeforeAgent: [{ hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }] }]
        }
      }),
      'utf8'
    )

    removeRetiredGeminiManagedHooksLocal()

    const settings = JSON.parse(readFileSync(join(settingsDir, 'settings.json'), 'utf8')) as {
      hooks: Record<string, unknown>
    }
    expect(settings.hooks).toEqual({
      BeforeAgent: [{ hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }] }]
    })
  })

  it('keeps the managed script when the settings file cannot be parsed', () => {
    // A JSONC settings.json may still hold a live entry pointing at the script;
    // deleting it would turn a 404 into empty stdout the Gemini CLI can't parse.
    const settingsDir = join(homeDir, '.gemini')
    const hooksDir = join(homeDir, '.orca', 'agent-hooks')
    mkdirSync(settingsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })
    const scriptPath = join(hooksDir, 'gemini-hook.sh')
    writeFileSync(scriptPath, 'noop', 'utf8')
    const raw = '{\n  // trailing comment style config\n  "hooks": {}\n}\n'
    writeFileSync(join(settingsDir, 'settings.json'), raw, 'utf8')

    removeRetiredGeminiManagedHooksLocal()

    expect(readFileSync(join(settingsDir, 'settings.json'), 'utf8')).toBe(raw)
    expect(existsSync(scriptPath)).toBe(true)
  })

  it('does not touch Antigravity hooks under ~/.gemini/config', () => {
    const antigravityDir = join(homeDir, '.gemini', 'config')
    mkdirSync(antigravityDir, { recursive: true })
    const antigravityHooks = {
      hooks: {
        PreToolUse: [{ command: '/bin/sh antigravity-hook.sh' }]
      }
    }
    writeFileSync(join(antigravityDir, 'hooks.json'), JSON.stringify(antigravityHooks), 'utf8')

    removeRetiredGeminiManagedHooksLocal()

    expect(JSON.parse(readFileSync(join(antigravityDir, 'hooks.json'), 'utf8'))).toEqual(
      antigravityHooks
    )
  })
})
