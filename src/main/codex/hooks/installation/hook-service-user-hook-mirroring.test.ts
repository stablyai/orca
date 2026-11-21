import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import '../../trust/toml/config-toml-trust'
import { upsertHookTrustContent as upsertHookTrustEntriesInContent } from '../../trust/toml/config-toml-hook-trust-edit'
import { hookTrustHeader, setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('../../trust/project-trust/codex-project-trust-worker-spawn', async () => ({
  spawnCodexProjectTrustWorker: (
    await import('../../trust/project-trust/codex-project-trust-worker.test-fixture')
  ).codexProjectTrustTestWorker.factory
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

  it('carries each SessionEnd user hook trust into the runtime home (STA-16540)', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    const command = 'node -e "process.exit(0)"'
    // Codex clamps both timeouts to 3s, so both hooks share one hash but keep their own trust.
    const sessionEndGroup = (timeout: number): object => ({
      matcher: 'other',
      hooks: [{ type: 'command', command, timeout }]
    })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({ hooks: { SessionEnd: [sessionEndGroup(5), sessionEndGroup(9)] } })}\n`,
      'utf-8'
    )
    // Hash codex-cli 0.170.0 reported for this hook.
    const codexHash = 'sha256:b4f5513d145df2d6d400f79b73a8f6e1a4eaa96484fbe4b793e802d7906e9e02'
    const systemTrust = (group: number, enabled: boolean): string =>
      `${hookTrustHeader(`${systemHooksPath}:session_end:${group}:0`, true)}\nenabled = ${enabled}\ntrusted_hash = "${codexHash}"`
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      `model = "system-model"\n\n${systemTrust(0, false)}\n\n${systemTrust(1, true)}\n`,
      'utf-8'
    )

    expect((await new CodexHookService().install()).state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    const runtimeTrust = (group: number, enabled: boolean): string =>
      `${hookTrustHeader(`${join(managedCodexHome, 'hooks.json')}:session_end:${group}:0`)}\nenabled = ${enabled}\ntrusted_hash = "${codexHash}"`
    expect(runtimeToml).toContain(runtimeTrust(0, false))
    expect(runtimeToml).toContain(runtimeTrust(1, true))
  })

  it('does not hand one approval to an identical hook the user never approved', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    const handler = { type: 'command', command: 'echo bye' }
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({ hooks: { PreCompact: [{ hooks: [handler, handler] }] } })}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'pre_compact',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'echo bye'
        }
      ]),
      'utf-8'
    )

    expect((await new CodexHookService().install()).state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    const runtimeHooksPath = join(managedCodexHome, 'hooks.json')
    expect(runtimeToml).toContain(hookTrustHeader(`${runtimeHooksPath}:pre_compact:0:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${runtimeHooksPath}:pre_compact:0:1`))
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
})
