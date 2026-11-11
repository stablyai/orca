import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { _internals as mirroredTrustInternals } from '../../codex-mirrored-hook-runtime-trust'
import '../../trust/toml/config-toml-trust'
import { readHookTrustEntries } from '../../trust/toml/config-toml-trust'
import { upsertHookTrustContent as upsertHookTrustEntriesInContent } from '../../trust/toml/config-toml-hook-trust-edit'
import { getExplicitHomeCodexHookSourcePath as getCodexExplicitHomeHookSourcePath } from '../../trust/identity/codex-trust-identity'
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

import './hook-service'
import { CodexHookService } from './codex-hook-service-implementation'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

afterEach(() => {
  mirroredTrustInternals.setListRunner(null)
  mirroredTrustInternals.resetRetryState()
})

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
  it('preserves mirrored user hooks when the system hooks file cannot be read', async () => {
    const service = new CodexHookService()
    const { systemHooksPath, managedHooksPath } = seedSystemUserHook('user-hook')
    expect((await service.install()).state).toBe('installed')
    const systemBefore = readFileSync(systemHooksPath, 'utf-8')
    const before = readFileSync(managedHooksPath, 'utf-8')

    rmSync(systemHooksPath)
    mkdirSync(systemHooksPath)

    for (const retry of [() => service.install(), () => service.refreshRuntimeUserHooks()]) {
      expect(await retry()).toMatchObject({
        state: 'error',
        detail: 'Could not read system Codex hooks.json'
      })
      expect(readFileSync(managedHooksPath, 'utf-8')).toBe(before)
    }

    rmSync(systemHooksPath, { recursive: true })
    writeFileSync(systemHooksPath, systemBefore, 'utf-8')
    expect((await service.install()).state).toBe('installed')
    expect(readRuntimeHookCommands(managedHooksPath)).toContain('user-hook')
  })

  it.each(['absent', 'malformed'] as const)(
    'rebuilds mirrored user hooks when the system source is %s',
    async (sourceState) => {
      const service = new CodexHookService()
      const { systemHooksPath, managedHooksPath } = seedSystemUserHook('stale-user-hook')
      expect((await service.install()).state).toBe('installed')

      if (sourceState === 'absent') {
        rmSync(systemHooksPath)
      } else {
        writeFileSync(systemHooksPath, '{ not json', 'utf-8')
      }

      expect((await service.install()).state).toBe('installed')
      expect(readRuntimeHookCommands(managedHooksPath)).not.toContain('stale-user-hook')
    }
  )

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

    expect((await new CodexHookService().install()).state).toBe('installed')

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

    expect((await service.install()).state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeUserTrustHeader = hookTrustHeader(`${managedHooksPath}:stop:1:0`)
    expect(readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')).toContain(
      runtimeUserTrustHeader
    )

    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "system-model"\n', 'utf-8')
    expect((await service.install()).state).toBe('installed')

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).not.toContain(runtimeUserTrustHeader)
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
  })

  it('refreshes runtime user hooks without installing Orca-managed hooks', async () => {
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
    expect((await service.install()).state).toBe('installed')
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
  })

  it('writes Codex runtime currentHash for an approved mirrored user hook, not the system hash', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const systemHash = 'sha256:system-source-hash'
    const runtimeHash = 'sha256:runtime-current-hash'
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'user-pre-tool-hook' }] }]
        }
      })}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'pre_tool_use',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'user-pre-tool-hook',
          trustedHash: systemHash
        }
      ]),
      'utf-8'
    )
    mirroredTrustInternals.setListRunner((runtimeHomePath) => {
      const runtimeHooksPath = getCodexExplicitHomeHookSourcePath(
        join(runtimeHomePath, 'hooks.json')
      )
      return [
        {
          key: `${runtimeHooksPath}:pre_tool_use:1:0`,
          command: 'user-pre-tool-hook',
          currentHash: runtimeHash
        }
      ]
    })

    expect((await new CodexHookService().install()).state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const runtimeHooksPath = getCodexExplicitHomeHookSourcePath(
      join(managedCodexHome, 'hooks.json')
    )
    const runtimeTrust = readHookTrustEntries(join(managedCodexHome, 'config.toml'))
    expect(runtimeTrust.get(`${runtimeHooksPath}:pre_tool_use:1:0`)?.trustedHash).toBe(runtimeHash)
    expect(readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')).not.toContain(systemHash)
  })
})
