import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import {
  buildManagedCommandHook,
  MANAGED_HOOK_TIMEOUT_SECONDS
} from '../agent-hooks/installer-utils'
import {
  computeTrustedHash,
  getCodexExplicitHomeHookSourcePath,
  upsertHookTrustEntries
} from './config-toml-trust'
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

import { CodexHookService, getCodexManagedHookInstallMaterial } from './hook-service'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

type HooksJson = { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

/** The entry and trust an older build installed into a managed home, first in every event. */
function seedOlderBuildOrcaEntry(managedCodexHome: string): void {
  const material = getCodexManagedHookInstallMaterial()
  const hooksPath = join(managedCodexHome, 'hooks.json')
  mkdirSync(managedCodexHome, { recursive: true })
  const hooks = Object.fromEntries(
    material.events.map((eventName) => [
      eventName,
      [{ hooks: [buildManagedCommandHook(material.command)] }]
    ])
  )
  writeFileSync(hooksPath, `${JSON.stringify({ hooks }, null, 2)}\n`, 'utf-8')
  upsertHookTrustEntries(
    join(managedCodexHome, 'config.toml'),
    material.events.map((eventName) => ({
      sourcePath: getCodexExplicitHomeHookSourcePath(hooksPath),
      eventLabel: material.eventLabel[eventName],
      groupIndex: 0,
      handlerIndex: 0,
      command: material.command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    }))
  )
}

function hasOrcaEntry(hooksPath: string): boolean {
  const config: HooksJson = JSON.parse(readFileSync(hooksPath, 'utf-8'))
  return Object.values(config.hooks).some((definitions) =>
    definitions.some((definition) =>
      definition.hooks?.some((hook) => isCodexManagedCommand(hook.command))
    )
  )
}

describe('CodexHookService', () => {
  it('removes managed trust entries when userData resolves through a symlink', async () => {
    const linkedUserDataDir = join(homes.tmpHome, 'linked-user-data')
    symlinkSync(
      homes.userDataDir,
      linkedUserDataDir,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    process.env.ORCA_USER_DATA_PATH = linkedUserDataDir

    const service = new CodexHookService()
    const linkedManagedCodexHome = join(linkedUserDataDir, 'codex-runtime-home', 'home')
    seedOlderBuildOrcaEntry(linkedManagedCodexHome)

    const linkedHooksPath = join(linkedManagedCodexHome, 'hooks.json')
    let runtimeToml = readFileSync(join(linkedManagedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${linkedHooksPath}:permission_request:0:0`))

    const status = await service.remove()

    expect(status.state).toBe('not_installed')
    runtimeToml = readFileSync(join(linkedManagedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).not.toContain(':permission_request:0:0')
    expect(runtimeToml).not.toContain(':stop:0:0')
  })

  it('removes legacy managed trust entries hashed before hook timeouts existed', async () => {
    const service = new CodexHookService()
    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    seedOlderBuildOrcaEntry(managedCodexHome)

    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeTomlPath = join(managedCodexHome, 'config.toml')
    const hooksConfig = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const command = hooksConfig.hooks.PermissionRequest?.[0]?.hooks?.[0]?.command
    expect(command).toBeDefined()
    const legacyHash = computeTrustedHash({
      sourcePath: managedHooksPath,
      eventLabel: 'permission_request',
      groupIndex: 0,
      handlerIndex: 0,
      command: command!
    })
    writeFileSync(
      runtimeTomlPath,
      [
        hookTrustHeader(`${managedHooksPath}:permission_request:0:0`),
        'enabled = true',
        `trusted_hash = "${legacyHash}"`,
        ''
      ].join('\n'),
      'utf-8'
    )

    expect((await service.remove()).state).toBe('not_installed')

    const runtimeToml = readFileSync(runtimeTomlPath, 'utf-8')
    expect(runtimeToml).not.toContain(':permission_request:0:0')
  })

  it('mirrors system Codex config while preserving runtime hook trust on the refresh', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "system-model"\n', 'utf-8')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    mkdirSync(managedCodexHome, { recursive: true })
    writeFileSync(
      join(managedCodexHome, 'config.toml'),
      [
        'model = "runtime-model"',
        '',
        '[hooks.state."runtime-hook"]',
        'enabled = false',
        'trusted_hash = "sha256:runtime"',
        ''
      ].join('\n'),
      'utf-8'
    )

    const status = await new CodexHookService().refreshRuntimeUserHooks()

    expect(status.state).toBe('not_installed')
    const trustConfig = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(trustConfig).toContain('model = "system-model"')
    expect(trustConfig).toContain('[hooks.state."runtime-hook"]')
    expect(trustConfig).toContain('enabled = false')
    expect(trustConfig).toContain('trusted_hash = "sha256:runtime"')
    expect(trustConfig).not.toContain(':permission_request:0:0')
    expect(hasOrcaEntry(join(managedCodexHome, 'hooks.json'))).toBe(false)
    expect(trustConfig).not.toContain('model = "runtime-model"')
  })

  it('clears duplicate PermissionRequest trust tables an older build left on the refresh', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "system-model"\n', 'utf-8')

    const service = new CodexHookService()
    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    seedOlderBuildOrcaEntry(managedCodexHome)

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
    const permissionRequestBlock = installedToml
      .slice(
        permissionRequestIndex,
        nextHeaderIndex === -1 ? installedToml.length : nextHeaderIndex
      )
      .trimEnd()
    const staleDisabledBlock = permissionRequestBlock
      .replace('enabled = true', 'enabled = false')
      .replace(/trusted_hash = "[^"]+"/, 'trusted_hash = "sha256:STALE_DISABLED"')
    const staleEnabledBlock = permissionRequestBlock.replace(
      /trusted_hash = "[^"]+"/,
      'trusted_hash = "sha256:STALE_ENABLED"'
    )
    writeFileSync(
      runtimeTomlPath,
      `${installedToml.slice(
        0,
        permissionRequestIndex
      )}${staleDisabledBlock}\n\n${staleEnabledBlock}${installedToml.slice(
        nextHeaderIndex === -1 ? installedToml.length : nextHeaderIndex
      )}`,
      'utf-8'
    )
    expect(readFileSync(runtimeTomlPath, 'utf-8').split(permissionRequestHeader)).toHaveLength(3)

    expect((await service.refreshRuntimeUserHooks()).state).toBe('not_installed')

    const repairedToml = readFileSync(runtimeTomlPath, 'utf-8')
    expect(repairedToml).not.toContain(permissionRequestHeader)
    expect(repairedToml).not.toContain('STALE_DISABLED')
    expect(repairedToml).not.toContain('STALE_ENABLED')
    expect(repairedToml).toContain('model = "system-model"')
    expect(hasOrcaEntry(managedHooksPath)).toBe(false)
  })

  it('preserves runtime-only project trust while honoring system project untrust', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      ['model = "system-model"', '', '[projects."/repo"]', 'trust_level = "untrusted"', ''].join(
        '\n'
      ),
      'utf-8'
    )

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    mkdirSync(managedCodexHome, { recursive: true })
    writeFileSync(
      join(managedCodexHome, 'config.toml'),
      [
        'model = "runtime-model"',
        '',
        '[projects."/repo"]',
        'trust_level = "trusted"',
        '',
        '[projects."/runtime-only"]',
        'trust_level = "trusted"',
        ''
      ].join('\n'),
      'utf-8'
    )

    const status = await new CodexHookService().refreshRuntimeUserHooks()

    expect(status.state).toBe('not_installed')
    const trustConfig = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(trustConfig).toContain('model = "system-model"')
    expect(trustConfig).toContain('[projects."/repo"]\ntrust_level = "untrusted"')
    expect(trustConfig).toContain('[projects."/runtime-only"]\ntrust_level = "trusted"')
    expect(trustConfig).not.toContain('model = "runtime-model"')
  })
})
