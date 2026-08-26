import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
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

function seedSystemUserHook(command: string): {
  systemHooksPath: string
  managedHooksPath: string
} {
  const systemCodexHome = join(homes.tmpHome, '.codex')
  const systemHooksPath = join(systemCodexHome, 'hooks.json')
  mkdirSync(systemCodexHome, { recursive: true })
  writeFileSync(
    systemHooksPath,
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } })}\n`,
    'utf-8'
  )
  writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "system-model"\n', 'utf-8')
  return {
    systemHooksPath,
    managedHooksPath: join(homes.userDataDir, 'codex-runtime-home', 'home', 'hooks.json')
  }
}

function readRuntimeHookCommands(managedHooksPath: string): string[] {
  const runtime = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
    hooks: Record<string, { hooks?: { command?: string }[] }[]>
  }
  return Object.values(runtime.hooks).flatMap((definitions) =>
    definitions.flatMap(
      (definition) => definition.hooks?.flatMap((hook) => hook.command ?? []) ?? []
    )
  )
}

function markHookTrustDisabled(toml: string, header: string): string {
  const headerIndex = toml.indexOf(header)
  expect(headerIndex).not.toBe(-1)
  const nextHeaderIndex = toml.indexOf('\n[', headerIndex + header.length)
  const blockEnd = nextHeaderIndex === -1 ? toml.length : nextHeaderIndex
  const block = toml.slice(headerIndex, blockEnd)
  expect(block).toContain('enabled = true')
  return `${toml.slice(0, headerIndex)}${block.replace('enabled = true', 'enabled = false')}${toml.slice(blockEnd)}`
}

describe('CodexHookService', () => {
  it('preserves mirrored user hooks when the system hooks file cannot be read', () => {
    const service = new CodexHookService()
    const { systemHooksPath, managedHooksPath } = seedSystemUserHook('user-hook')
    expect(service.install().state).toBe('installed')
    const systemBefore = readFileSync(systemHooksPath, 'utf-8')
    const before = readFileSync(managedHooksPath, 'utf-8')

    rmSync(systemHooksPath)
    mkdirSync(systemHooksPath)

    for (const retry of [() => service.install(), () => service.refreshRuntimeUserHooks()]) {
      expect(retry()).toMatchObject({
        state: 'error',
        detail: 'Could not read system Codex hooks.json'
      })
      expect(readFileSync(managedHooksPath, 'utf-8')).toBe(before)
    }

    rmSync(systemHooksPath, { recursive: true })
    writeFileSync(systemHooksPath, systemBefore, 'utf-8')
    expect(service.install().state).toBe('installed')
    expect(readRuntimeHookCommands(managedHooksPath)).toContain('user-hook')
  })

  it.each(['absent', 'malformed'] as const)(
    'rebuilds mirrored user hooks when the system source is %s',
    (sourceState) => {
      const service = new CodexHookService()
      const { systemHooksPath, managedHooksPath } = seedSystemUserHook('stale-user-hook')
      expect(service.install().state).toBe('installed')

      if (sourceState === 'absent') {
        rmSync(systemHooksPath)
      } else {
        writeFileSync(systemHooksPath, '{ not json', 'utf-8')
      }

      expect(service.install().state).toBe('installed')
      expect(readRuntimeHookCommands(managedHooksPath)).not.toContain('stale-user-hook')
    }
  )

  it('mirrors trusted system user hook approvals into the runtime CODEX_HOME', () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: 'user-hook',
                    timeout: 12,
                    async: true,
                    statusMessage: 'Running user hook'
                  }
                ]
              }
            ]
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
          groupIndex: 0,
          handlerIndex: 0,
          command: 'user-hook',
          timeoutSec: 12,
          async: true,
          matcher: '*',
          statusMessage: 'Running user hook'
        }
      ]),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<
        string,
        { matcher?: string; hooks?: { command?: string; statusMessage?: string }[] }[]
      >
    }
    expect(runtimeHooks.hooks.Stop?.[1]?.matcher).toBe('*')
    expect(runtimeHooks.hooks.Stop?.[1]?.hooks?.[0]?.command).toBe('user-hook')
    expect(runtimeHooks.hooks.Stop?.[1]?.hooks?.[0]?.statusMessage).toBe('Running user hook')

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:1:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:stop:0:0`, true))
  })

  it('runs managed PostToolUse status before mirrored user hooks', () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: {
          PostToolUse: [{ hooks: [{ type: 'command', command: 'slow-user-post-tool-hook' }] }]
        }
      })}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'post_tool_use',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'slow-user-post-tool-hook'
        }
      ]),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }

    expect(isCodexManagedCommand(runtimeHooks.hooks.PostToolUse?.[0]?.hooks?.[0]?.command)).toBe(
      true
    )
    expect(runtimeHooks.hooks.PostToolUse?.[1]?.hooks?.[0]?.command).toBe(
      'slow-user-post-tool-hook'
    )

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:post_tool_use:0:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:post_tool_use:1:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:post_tool_use:0:0`, true))
  })

  it('mirrors system user hook approvals when the system trust indices are stale', () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'first-stop-hook' }] },
              { hooks: [{ type: 'command', command: 'second-stop-hook' }] }
            ]
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
          groupIndex: 0,
          handlerIndex: 0,
          command: 'second-stop-hook'
        },
        {
          sourcePath: systemHooksPath,
          eventLabel: 'stop',
          groupIndex: 1,
          handlerIndex: 0,
          command: 'first-stop-hook'
        }
      ]),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:1:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:2:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:stop:0:0`, true))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:stop:1:0`, true))
  })

  it('skips plugin-placeholder system hooks when mirroring into runtime CODEX_HOME', () => {
    const pluginCommands = [
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.mjs"',
      'node "${CLAUDE_PLUGIN_DATA}/scripts/on-stop.mjs"',
      'node "${PLUGIN_ROOT}/scripts/on-stop.mjs"',
      'node "${PLUGIN_DATA}/scripts/on-stop.mjs"'
    ]
    const userCommand = 'user-stop-hook'
    const stopEventLabel = 'stop' as const
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  ...pluginCommands.map((command) => ({ type: 'command', command })),
                  { type: 'command', command: userCommand }
                ]
              }
            ],
            PreCompact: pluginCommands.map((command) => ({
              hooks: [{ type: 'command', command }]
            }))
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
        ...pluginCommands.map((command, handlerIndex) => ({
          sourcePath: systemHooksPath,
          eventLabel: stopEventLabel,
          groupIndex: 0,
          handlerIndex,
          command
        })),
        {
          sourcePath: systemHooksPath,
          eventLabel: stopEventLabel,
          groupIndex: 0,
          handlerIndex: pluginCommands.length,
          command: userCommand
        }
      ]),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooksText = readFileSync(managedHooksPath, 'utf-8')
    const runtimeHooks = JSON.parse(runtimeHooksText) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const stopCommands =
      runtimeHooks.hooks.Stop?.flatMap(
        (definition) => definition.hooks?.map((hook) => hook.command ?? '') ?? []
      ) ?? []

    expect(stopCommands).toContain(userCommand)
    expect(stopCommands.some((command) => isCodexManagedCommand(command))).toBe(true)
    expect(runtimeHooks.hooks.PreCompact).toBeUndefined()
    for (const command of pluginCommands) {
      expect(runtimeHooksText).not.toContain(command)
    }

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:1:0`))
    for (const command of pluginCommands) {
      expect(runtimeToml).not.toContain(command)
    }
  })

  it('mirrors compact-event user hook approvals and disabled trust entries', () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            PreCompact: [{ hooks: [{ type: 'command', command: 'pre-compact-user' }] }],
            PostCompact: [{ hooks: [{ type: 'command', command: 'post-compact-disabled' }] }]
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    const disabledPostCompactHeader = hookTrustHeader(`${systemHooksPath}:post_compact:0:0`, true)
    const systemToml = upsertHookTrustEntriesInContent('model = "system-model"\n', [
      {
        sourcePath: systemHooksPath,
        eventLabel: 'pre_compact',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'pre-compact-user'
      },
      {
        sourcePath: systemHooksPath,
        eventLabel: 'post_compact',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'post-compact-disabled'
      }
    ])
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      markHookTrustDisabled(systemToml, disabledPostCompactHeader),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    expect(runtimeHooks.hooks.PreCompact?.[0]?.hooks?.[0]?.command).toBe('pre-compact-user')
    expect(runtimeHooks.hooks.PostCompact?.[0]?.hooks?.[0]?.command).toBe('post-compact-disabled')

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(
      `${hookTrustHeader(`${managedHooksPath}:pre_compact:0:0`)}\nenabled = true`
    )
    expect(runtimeToml).toContain(
      `${hookTrustHeader(`${managedHooksPath}:post_compact:0:0`)}\nenabled = false`
    )
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:pre_compact:0:0`, true))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:post_compact:0:0`, true))
  })

  it('removes runtime user hook trust after system approval is revoked', () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] }
      })}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'user-hook'
        }
      ]),
      'utf-8'
    )
    const service = new CodexHookService()

    expect(service.install().state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeUserTrustHeader = hookTrustHeader(`${managedHooksPath}:stop:1:0`)
    expect(readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')).toContain(
      runtimeUserTrustHeader
    )

    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "system-model"\n', 'utf-8')
    expect(service.install().state).toBe('installed')

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).not.toContain(runtimeUserTrustHeader)
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
  })

  it('refreshes mirrored system user hooks when the system hooks file changes', () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook-old' }] }] }
      })}\n`,
      'utf-8'
    )

    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')

    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook-new' }] }] }
      })}\n`,
      'utf-8'
    )
    expect(service.install().state).toBe('installed')

    const managedHooksPath = join(homes.userDataDir, 'codex-runtime-home', 'home', 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const stopCommands =
      runtimeHooks.hooks.Stop?.flatMap(
        (definition) => definition.hooks?.map((hook) => hook.command ?? '') ?? []
      ) ?? []
    expect(stopCommands).toContain('user-hook-new')
    expect(stopCommands).not.toContain('user-hook-old')
  })

  it('refreshes runtime user hooks without installing Orca-managed hooks', () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop-hook' }] }] }
      })}\n`,
      'utf-8'
    )
    const disabledStopHeader = hookTrustHeader(`${systemHooksPath}:stop:0:0`, true)
    const systemToml = upsertHookTrustEntriesInContent('model = "system-model"\n', [
      {
        sourcePath: systemHooksPath,
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'user-stop-hook'
      }
    ])
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      markHookTrustDisabled(systemToml, disabledStopHeader),
      'utf-8'
    )

    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')
    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeTomlPath = join(managedCodexHome, 'config.toml')
    const permissionRequestHeader = hookTrustHeader(`${managedHooksPath}:permission_request:0:0`)
    const installedToml = readFileSync(runtimeTomlPath, 'utf-8')
    const permissionRequestIndex = installedToml.indexOf(permissionRequestHeader)
    expect(permissionRequestIndex).not.toBe(-1)
    const nextHeaderIndex = installedToml.indexOf(
      '\n[',
      permissionRequestIndex + permissionRequestHeader.length
    )
    const permissionRequestBlock = installedToml.slice(
      permissionRequestIndex,
      nextHeaderIndex === -1 ? installedToml.length : nextHeaderIndex
    )
    writeFileSync(
      runtimeTomlPath,
      `${installedToml.trimEnd()}\n\n${permissionRequestBlock.trimEnd()}\n`,
      'utf-8'
    )

    const status = service.refreshRuntimeUserHooks()

    expect(status.state).toBe('not_installed')
    expect(status.managedHooksPresent).toBe(false)
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const runtimeCommands = Object.values(runtimeHooks.hooks).flatMap((definitions) =>
      definitions.flatMap((definition) => definition.hooks?.map((hook) => hook.command ?? '') ?? [])
    )
    expect(runtimeCommands).toEqual(['user-stop-hook'])
    expect(runtimeCommands.some((command) => command.includes('codex-hook'))).toBe(false)

    const runtimeToml = readFileSync(runtimeTomlPath, 'utf-8')
    expect(runtimeToml).toContain(
      `${hookTrustHeader(`${managedHooksPath}:stop:0:0`)}\nenabled = false`
    )
    expect(runtimeToml).not.toContain(':permission_request:0:0')
  })
})
