import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import {
  codexHookSourcePathsEqual,
  computeTrustedHash,
  getCodexExplicitHomeHookSourcePath,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntriesInContent
} from './config-toml-trust'
import { CODEX_HOOK_EVENT_LABEL } from './codex-hook-identity'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import { hookTrustHeader, setupCodexHookHomes } from './hook-service-test-harness'

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

// Why: Orca's status hook rides each launch as a session flag, never a managed-home
// entry. Trust tables carry no command, so check every key against a live user hook.
function expectNoOrcaEntry(managedCodexHome: string): void {
  const managedHooksPath = join(managedCodexHome, 'hooks.json')
  const hooksText = readFileSync(managedHooksPath, 'utf-8')
  expect(hooksText).not.toContain('codex-hook.')
  const runtimeHooks: { hooks: Record<string, { hooks?: { command?: string }[] }[]> } =
    JSON.parse(hooksText)
  const userHookPositions = new Set<string>()
  for (const [eventName, definitions] of Object.entries(runtimeHooks.hooks)) {
    definitions.forEach((definition, groupIndex) => {
      definition.hooks?.forEach((_hook, handlerIndex) => {
        userHookPositions.add(`${CODEX_HOOK_EVENT_LABEL[eventName]}:${groupIndex}:${handlerIndex}`)
      })
    })
  }
  const managedCommand = getManagedCommand(getManagedScriptPath())
  const trustSourcePath = getCodexExplicitHomeHookSourcePath(managedHooksPath)
  for (const [key, state] of readHookTrustEntries(join(managedCodexHome, 'config.toml'))) {
    const parsed = parseTrustKey(key)
    if (!parsed || !codexHookSourcePathsEqual(parsed.sourcePath, trustSourcePath)) {
      continue
    }
    const { eventLabel, groupIndex, handlerIndex } = parsed
    expect(userHookPositions).toContain(`${eventLabel}:${groupIndex}:${handlerIndex}`)
    expect(state.trustedHash).not.toBe(
      computeTrustedHash({
        sourcePath: trustSourcePath,
        eventLabel,
        groupIndex,
        handlerIndex,
        command: managedCommand
      })
    )
  }
}

describe('CodexHookService', () => {
  it('preserves mirrored user hooks when the system hooks file cannot be read', async () => {
    const service = new CodexHookService()
    const { systemHooksPath, managedHooksPath } = seedSystemUserHook('user-hook')
    expect((await service.refreshRuntimeUserHooks()).state).not.toBe('error')
    const systemBefore = readFileSync(systemHooksPath, 'utf-8')
    const before = readFileSync(managedHooksPath, 'utf-8')

    rmSync(systemHooksPath)
    mkdirSync(systemHooksPath)

    for (const retry of [
      () => service.refreshRuntimeUserHooksForLaunchPrep(),
      () => service.refreshRuntimeUserHooks()
    ]) {
      expect(await retry()).toMatchObject({
        state: 'error',
        detail: 'Could not read system Codex hooks.json'
      })
      expect(readFileSync(managedHooksPath, 'utf-8')).toBe(before)
    }

    rmSync(systemHooksPath, { recursive: true })
    writeFileSync(systemHooksPath, systemBefore, 'utf-8')
    expect((await service.refreshRuntimeUserHooks()).state).not.toBe('error')
    expect(readRuntimeHookCommands(managedHooksPath)).toEqual(['user-hook'])
    expectNoOrcaEntry(join(managedHooksPath, '..'))
  })

  it.each(['absent', 'malformed'] as const)(
    'rebuilds mirrored user hooks when the system source is %s',
    async (sourceState) => {
      const service = new CodexHookService()
      const { systemHooksPath, managedHooksPath } = seedSystemUserHook('stale-user-hook')
      expect((await service.refreshRuntimeUserHooks()).state).not.toBe('error')

      if (sourceState === 'absent') {
        rmSync(systemHooksPath)
      } else {
        writeFileSync(systemHooksPath, '{ not json', 'utf-8')
      }

      expect((await service.refreshRuntimeUserHooks()).state).not.toBe('error')
      expect(readRuntimeHookCommands(managedHooksPath)).not.toContain('stale-user-hook')
      expectNoOrcaEntry(join(managedHooksPath, '..'))
    }
  )

  it('mirrors trusted system user hook approvals into the runtime CODEX_HOME', async () => {
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

    expect((await new CodexHookService().refreshRuntimeUserHooks()).state).not.toBe('error')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<
        string,
        { matcher?: string; hooks?: { command?: string; statusMessage?: string }[] }[]
      >
    }
    expect(runtimeHooks.hooks.Stop).toHaveLength(1)
    expect(runtimeHooks.hooks.Stop?.[0]?.matcher).toBe('*')
    expect(runtimeHooks.hooks.Stop?.[0]?.hooks?.[0]?.command).toBe('user-hook')
    expect(runtimeHooks.hooks.Stop?.[0]?.hooks?.[0]?.statusMessage).toBe('Running user hook')

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${managedHooksPath}:stop:1:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:stop:0:0`, true))
    expectNoOrcaEntry(managedCodexHome)
  })

  it('mirrors a PostToolUse user hook with no Orca status entry ahead of it', async () => {
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

    expect((await new CodexHookService().refreshRuntimeUserHooks()).state).not.toBe('error')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }

    expect(runtimeHooks.hooks.PostToolUse).toHaveLength(1)
    expect(runtimeHooks.hooks.PostToolUse?.[0]?.hooks?.[0]?.command).toBe(
      'slow-user-post-tool-hook'
    )

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:post_tool_use:0:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${managedHooksPath}:post_tool_use:1:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:post_tool_use:0:0`, true))
    expectNoOrcaEntry(managedCodexHome)
  })

  it('mirrors system user hook approvals when the system trust indices are stale', async () => {
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

    expect((await new CodexHookService().refreshRuntimeUserHooks()).state).not.toBe('error')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:1:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${managedHooksPath}:stop:2:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:stop:0:0`, true))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:stop:1:0`, true))
    expectNoOrcaEntry(managedCodexHome)
  })

  it('skips plugin-placeholder system hooks when mirroring into runtime CODEX_HOME', async () => {
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

    expect((await new CodexHookService().refreshRuntimeUserHooks()).state).not.toBe('error')

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

    expect(stopCommands).toEqual([userCommand])
    expect(runtimeHooks.hooks.PreCompact).toBeUndefined()
    for (const command of pluginCommands) {
      expect(runtimeHooksText).not.toContain(command)
    }

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${managedHooksPath}:stop:1:0`))
    for (const command of pluginCommands) {
      expect(runtimeToml).not.toContain(command)
    }
    expectNoOrcaEntry(managedCodexHome)
  })

  it('mirrors compact-event user hook approvals and disabled trust entries', async () => {
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

    expect((await new CodexHookService().refreshRuntimeUserHooks()).state).not.toBe('error')

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
    expectNoOrcaEntry(managedCodexHome)
  })

  it('removes runtime user hook trust after system approval is revoked', async () => {
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

    expect((await service.refreshRuntimeUserHooks()).state).not.toBe('error')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeUserTrustHeader = hookTrustHeader(`${managedHooksPath}:stop:0:0`)
    expect(readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')).toContain(
      runtimeUserTrustHeader
    )

    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "system-model"\n', 'utf-8')
    expect((await service.refreshRuntimeUserHooks()).state).not.toBe('error')

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).not.toContain(runtimeUserTrustHeader)
    expect(runtimeToml).not.toContain('[hooks.state.')
    expectNoOrcaEntry(managedCodexHome)
  })

  it('refreshes mirrored system user hooks when the system hooks file changes', async () => {
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
    expect((await service.refreshRuntimeUserHooks()).state).not.toBe('error')

    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook-new' }] }] }
      })}\n`,
      'utf-8'
    )
    expect((await service.refreshRuntimeUserHooks()).state).not.toBe('error')

    const managedHooksPath = join(homes.userDataDir, 'codex-runtime-home', 'home', 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const stopCommands =
      runtimeHooks.hooks.Stop?.flatMap(
        (definition) => definition.hooks?.map((hook) => hook.command ?? '') ?? []
      ) ?? []
    expect(stopCommands).toEqual(['user-hook-new'])
    expectNoOrcaEntry(join(managedHooksPath, '..'))
  })

  it("strips an older build's Orca entries and duplicated trust while mirroring user hooks", async () => {
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

    // An older build installed Orca's entry on every event ahead of the mirrored
    // user hook, and Codex duplicated the PermissionRequest trust table.
    const service = new CodexHookService()
    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeTomlPath = join(managedCodexHome, 'config.toml')
    const managedCommand = getManagedCommand(getManagedScriptPath())
    const legacyHooks: Record<string, { hooks: { type: string; command: string }[] }[]> = {}
    for (const eventName of CODEX_EVENTS) {
      legacyHooks[eventName] = [{ hooks: [{ type: 'command', command: managedCommand }] }]
    }
    legacyHooks.Stop!.push({ hooks: [{ type: 'command', command: 'user-stop-hook' }] })
    mkdirSync(managedCodexHome, { recursive: true })
    writeFileSync(managedHooksPath, `${JSON.stringify({ hooks: legacyHooks })}\n`, 'utf-8')
    const installedToml = upsertHookTrustEntriesInContent(
      '',
      CODEX_EVENTS.map((eventName) => ({
        sourcePath: getCodexExplicitHomeHookSourcePath(managedHooksPath),
        eventLabel: CODEX_EVENT_LABEL[eventName],
        groupIndex: 0,
        handlerIndex: 0,
        command: managedCommand
      }))
    )
    const permissionRequestHeader = hookTrustHeader(`${managedHooksPath}:permission_request:0:0`)
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
    expect(readHookTrustEntries(runtimeTomlPath).size).toBe(CODEX_EVENTS.length)

    const status = await service.refreshRuntimeUserHooks()

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
    expectNoOrcaEntry(managedCodexHome)
  })
})
