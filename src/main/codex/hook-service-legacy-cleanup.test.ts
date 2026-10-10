import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import { upsertHookTrustEntriesInContent } from './config-toml-trust'
import {
  hookTrustHeader,
  isCodexManagedCommand,
  setupCodexHookHomes
} from './hook-service-test-harness'

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
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { CodexHookService } from './hook-service'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

const LEGACY_ORCA_PROFILE_LINES = [
  '# BEGIN ORCA AGENT STATUS HOOKS',
  '[[hooks.PermissionRequest]]',
  '[[hooks.PermissionRequest.hooks]]',
  'type = "command"',
  'command = "codex-hook"',
  '# END ORCA AGENT STATUS HOOKS',
  ''
]

// Why a retired form: the sweep may remove only commands no current build writes
// (#1536's exec-guarded form on POSIX, a per-userData bare path on Windows).
function legacyManagedHookCommand(): string {
  if (process.platform === 'win32') {
    return join(homes.userDataDir, 'agent-hooks', 'codex-hook.cmd')
  }
  const quoted = `'${join(homes.tmpHome, '.orca', 'agent-hooks', 'codex-hook.sh')}'`
  return `if [ -x ${quoted} ]; then /bin/sh ${quoted}; fi`
}

function currentManagedHookCommand(): string {
  const scriptPath = join(
    homes.tmpHome,
    '.orca',
    'agent-hooks',
    process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
  )
  return process.platform === 'win32' ? scriptPath : wrapPosixHookCommand(scriptPath)
}

describe('CodexHookService', () => {
  // Why: every Orca on this HOME writes the same current entry; an install for a
  // managed account (launch prep for any pane) used to strip it and its trust.
  it('keeps the shared current entry and its trust while removing a retired form', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const currentCommand = currentManagedHookCommand()
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'user-hook' }] },
              { hooks: [{ type: 'command', command: currentCommand, timeout: 10 }] }
            ],
            SessionStart: [{ hooks: [{ type: 'command', command: legacyManagedHookCommand() }] }]
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    const currentTrust = {
      sourcePath: systemHooksPath,
      eventLabel: 'stop' as const,
      groupIndex: 1,
      handlerIndex: 0,
      command: currentCommand,
      timeoutSec: 10
    }
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [currentTrust]),
      'utf-8'
    )

    expect((await new CodexHookService().install()).state).toBe('installed')

    const systemHooks = JSON.parse(readFileSync(systemHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    expect(systemHooks.hooks.Stop?.[1]?.hooks?.[0]?.command).toBe(currentCommand)
    expect(systemHooks.hooks.SessionStart).toBeUndefined()
    expect(readFileSync(join(systemCodexHome, 'config.toml'), 'utf-8')).toContain(':stop:1:0')
  })

  it('removes legacy Orca-managed hooks from system ~/.codex during install', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const legacyCommand = legacyManagedHookCommand()
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'user-hook' }] },
              { hooks: [{ type: 'command', command: legacyCommand }] }
            ],
            SessionStart: [{ hooks: [{ type: 'command', command: legacyCommand }] }]
          },
          _managed: {
            'external-manager': {
              Stop: [0]
            }
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'stop',
          groupIndex: 1,
          handlerIndex: 0,
          command: legacyCommand
        },
        {
          sourcePath: systemHooksPath,
          eventLabel: 'session_start',
          groupIndex: 0,
          handlerIndex: 0,
          command: legacyCommand
        }
      ]),
      'utf-8'
    )

    expect((await new CodexHookService().install()).state).toBe('installed')

    const systemHooks = JSON.parse(readFileSync(systemHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
      _managed?: unknown
    }
    expect(systemHooks.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'user-hook' }] }])
    expect(systemHooks.hooks.SessionStart).toBeUndefined()
    expect(systemHooks._managed).toEqual({ 'external-manager': { Stop: [0] } })
    const systemToml = readFileSync(join(systemCodexHome, 'config.toml'), 'utf-8')
    expect(systemToml).toContain('model = "system-model"')
    expect(systemToml).not.toContain(':stop:1:0')
    expect(systemToml).not.toContain(':session_start:0:0')
  })

  it('removes very large legacy Orca-managed hook lists from system ~/.codex', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const legacyCommand = legacyManagedHookCommand()
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: {
          Stop: Array.from({ length: 30_000 }, () => ({
            hooks: [{ type: 'command', command: legacyCommand }]
          }))
        }
      })}\n`,
      'utf-8'
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      expect((await new CodexHookService().install()).state).toBe('installed')

      expect(warnSpy).not.toHaveBeenCalledWith(
        '[codex-hook-service] failed to clean legacy Codex hooks',
        expect.anything()
      )
    } finally {
      warnSpy.mockRestore()
    }
    const systemHooks = JSON.parse(readFileSync(systemHooksPath, 'utf-8')) as {
      hooks: Record<string, unknown>
    }
    expect(systemHooks.hooks.Stop).toBeUndefined()
  }, 30_000)

  it('removes the legacy Orca Codex profile file when it only contains managed hooks', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const profilePath = join(systemCodexHome, 'orca-agent-status.config.toml')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(profilePath, LEGACY_ORCA_PROFILE_LINES.join('\n'), 'utf-8')

    expect((await new CodexHookService().install()).state).toBe('installed')

    expect(existsSync(profilePath)).toBe(false)
  })

  it('removes only the legacy Orca block from a user-edited Codex profile file', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const profilePath = join(systemCodexHome, 'orca-agent-status.config.toml')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      profilePath,
      ['model = "gpt-5.5"', '', ...LEGACY_ORCA_PROFILE_LINES].join('\n'),
      'utf-8'
    )

    expect((await new CodexHookService().install()).state).toBe('installed')

    const profileConfig = readFileSync(profilePath, 'utf-8')
    expect(profileConfig).toContain('model = "gpt-5.5"')
    expect(profileConfig).not.toContain('ORCA AGENT STATUS HOOKS')
    expect(profileConfig).not.toContain('codex-hook')
  })

  it('cleans legacy system and profile hooks when runtime hooks.json is malformed during remove', async () => {
    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    mkdirSync(managedCodexHome, { recursive: true })
    writeFileSync(join(managedCodexHome, 'hooks.json'), '{not json', 'utf-8')

    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const profilePath = join(systemCodexHome, 'orca-agent-status.config.toml')
    const legacyCommand = legacyManagedHookCommand()
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'user-hook' }] },
              { hooks: [{ type: 'command', command: legacyCommand }] }
            ],
            SessionStart: [{ hooks: [{ type: 'command', command: legacyCommand }] }]
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(profilePath, LEGACY_ORCA_PROFILE_LINES.join('\n'), 'utf-8')

    const status = await new CodexHookService().remove()

    expect(status.state).toBe('error')
    expect(status.detail).toBe('Could not parse Codex hooks.json')
    const systemHooks = JSON.parse(readFileSync(systemHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    expect(systemHooks.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'user-hook' }] }])
    expect(systemHooks.hooks.SessionStart).toBeUndefined()
    expect(existsSync(profilePath)).toBe(false)
  })

  it('sanitizes runtime hooks.json metadata during remove even without managed hooks', async () => {
    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    mkdirSync(managedCodexHome, { recursive: true })
    // Why ~/.codex holds it too: remove() rebuilds the mirror's user hooks from ~/.codex.
    mkdirSync(join(homes.tmpHome, '.codex'), { recursive: true })
    writeFileSync(
      join(homes.tmpHome, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } })
    )
    writeFileSync(
      managedHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }]
          },
          _managed: {
            'compound-engineering': {
              Stop: [0]
            }
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )

    const status = await new CodexHookService().remove()

    expect(status.state).toBe('not_installed')
    const hooksConfig = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, unknown>
      _managed?: unknown
    }
    expect(hooksConfig._managed).toBeUndefined()
    expect(Object.keys(hooksConfig)).toEqual(['hooks'])
    expect(hooksConfig.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'user-hook' }] }])
  })

  it('cleans duplicate Codex hook representations while keeping status hooks in runtime CODEX_HOME', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const systemTomlPath = join(systemCodexHome, 'config.toml')
    const legacyProfilePath = join(systemCodexHome, 'orca-agent-status.config.toml')
    const legacyCommand = legacyManagedHookCommand()
    const userCommand = 'user-stop-hook'
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: userCommand }] },
              { hooks: [{ type: 'command', command: legacyCommand }] }
            ],
            SessionStart: [{ hooks: [{ type: 'command', command: legacyCommand }] }]
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(
      systemTomlPath,
      upsertHookTrustEntriesInContent(
        ['model = "system-model"', '', '[features]', 'codex_hooks = true', ''].join('\n'),
        [
          {
            sourcePath: systemHooksPath,
            eventLabel: 'stop',
            groupIndex: 0,
            handlerIndex: 0,
            command: userCommand
          },
          {
            sourcePath: systemHooksPath,
            eventLabel: 'session_start',
            groupIndex: 0,
            handlerIndex: 0,
            command: legacyCommand
          }
        ]
      ),
      'utf-8'
    )
    writeFileSync(legacyProfilePath, LEGACY_ORCA_PROFILE_LINES.join('\n'), 'utf-8')

    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const stopCommands =
      runtimeHooks.hooks.Stop?.flatMap(
        (definition) => definition.hooks?.map((hook) => hook.command ?? '') ?? []
      ) ?? []
    expect(stopCommands).toContain(userCommand)
    expect(stopCommands.some((command) => isCodexManagedCommand(command))).toBe(true)
    expect(
      isCodexManagedCommand(runtimeHooks.hooks.PermissionRequest?.[0]?.hooks?.[0]?.command)
    ).toBe(true)

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain('[features]\nhooks = true')
    expect(runtimeToml).not.toContain('codex_hooks')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:permission_request:0:0`))

    const systemHooks = JSON.parse(readFileSync(systemHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    expect(systemHooks.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: userCommand }] }])
    expect(systemHooks.hooks.SessionStart).toBeUndefined()
    const systemToml = readFileSync(systemTomlPath, 'utf-8')
    expect(systemToml).toContain('codex_hooks = true')
    expect(systemToml).not.toContain(':session_start:0:0')
    expect(existsSync(legacyProfilePath)).toBe(false)
    expect(service.getStatus(managedCodexHome).state).toBe('installed')
  })
})
