import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import '../../../agent-hooks/installer-utils'
import { wrapPosixHookCommand } from '../../../agent-hooks/posix-hook-command'
import '../../trust/toml/config-toml-trust'
import { upsertHookTrustContent as upsertHookTrustEntriesInContent } from '../../trust/toml/config-toml-hook-trust-edit'
import { setupCodexHookHomes } from './hook-service-test-harness'

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

import './hook-service'
import { CodexHookService } from './codex-hook-service-implementation'

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

// Only retired command forms are eligible for cleanup.
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
})
