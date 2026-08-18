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

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { QoderHookService } from './hook-service'

describe('QoderHookService', () => {
  let homeDir: string
  let userDataDir: string

  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-qoder-home-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-qoder-userdata-'))
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

  it('installs managed hooks into Claude-compatible events and preserves user hooks', () => {
    const configDir = join(homeDir, '.qoder')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              {
                matcher: '*',
                hooks: [{ type: 'command', command: 'echo user-post-tool' }]
              }
            ]
          }
        },
        null,
        2
      )
    )

    const status = new QoderHookService().install()
    const config = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))

    expect(status.state).toBe('installed')
    expect(Object.keys(config.hooks).sort()).toEqual([
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit'
    ])
    // Why: user-authored hooks survive alongside the managed entry.
    const postToolCommands = config.hooks.PostToolUse.flatMap(
      (definition: { hooks?: { command: string }[] }) =>
        (definition.hooks ?? []).map((hook) => hook.command)
    )
    expect(postToolCommands).toEqual(['echo user-post-tool', expect.stringContaining('qoder-hook')])
    expect(status.configPath).toBe(join(homeDir, '.qoder', 'settings.json'))
  })

  it('sweeps stale managed hooks from dropped event buckets on reinstall', () => {
    const configDir = join(homeDir, '.qoder')
    mkdirSync(configDir, { recursive: true })
    const managedHookFileName = process.platform === 'win32' ? 'qoder-hook.cmd' : 'qoder-hook.sh'
    const staleManagedHookPath =
      process.platform === 'win32'
        ? `C:\\Users\\ramzi\\.orca\\agent-hooks\\${managedHookFileName}`
        : `/Users/ramzi/.orca/agent-hooks/${managedHookFileName}`
    const staleManagedCommand =
      process.platform === 'win32'
        ? staleManagedHookPath
        : `if [ -x '${staleManagedHookPath}' ]; then /bin/sh '${staleManagedHookPath}'; fi`
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [{ type: 'command', command: staleManagedCommand }]
              }
            ],
            SessionEnd: [
              {
                hooks: [{ type: 'command', command: staleManagedCommand }]
              }
            ]
          }
        },
        null,
        2
      )
    )

    const status = new QoderHookService().install()
    const config = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))

    expect(status.state).toBe('installed')
    expect(config.hooks.SessionEnd).toBeUndefined()
    expect(config.hooks.SessionStart).toHaveLength(1)
  })

  it('remove() strips managed hooks and leaves user hooks untouched', () => {
    const configDir = join(homeDir, '.qoder')
    mkdirSync(configDir, { recursive: true })
    // Why: self-contained fixture so this test passes on its own, not just after install().
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [{ type: 'command', command: 'echo user-prompt' }]
              }
            ]
          }
        },
        null,
        2
      )
    )
    const service = new QoderHookService()
    service.install()
    const configWithManaged = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
    expect(configWithManaged.hooks.PreToolUse).toHaveLength(1)

    const status = service.remove()
    const after = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))

    expect(status.state).toBe('not_installed')
    expect(after.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'echo user-prompt' }] }
    ])
    expect(after.hooks.PreToolUse).toBeUndefined()
  })
})
