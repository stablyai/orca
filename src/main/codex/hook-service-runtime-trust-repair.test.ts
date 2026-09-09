import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { computeTrustedHash, getCodexExplicitHomeHookSourcePath } from './config-toml-trust'
import {
  escapeTomlBasicString,
  hookTrustHeader,
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
    expect((await service.install()).state).toBe('installed')

    const linkedManagedCodexHome = join(linkedUserDataDir, 'codex-runtime-home', 'home')
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
    expect((await service.install()).state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
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

  it('mirrors system Codex config while preserving runtime hook trust on hook install', async () => {
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

    const status = await new CodexHookService().install()

    expect(status.state).toBe('installed')
    const trustConfig = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(trustConfig).toContain('model = "system-model"')
    expect(trustConfig).toContain('[hooks.state."runtime-hook"]')
    expect(trustConfig).toContain('enabled = false')
    expect(trustConfig).toContain('trusted_hash = "sha256:runtime"')
    expect(trustConfig).toContain(':permission_request:0:0')
    expect(trustConfig).not.toContain('model = "runtime-model"')
  })

  it.skipIf(process.platform !== 'win32')(
    'treats legacy forward-slash runtime trust keys as installed before canonicalizing on reinstall',
    async () => {
      const service = new CodexHookService()
      expect((await service.install()).state).toBe('installed')

      const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
      const managedHooksPath = join(managedCodexHome, 'hooks.json')
      const runtimeTomlPath = join(managedCodexHome, 'config.toml')
      const canonicalPermissionHeader = hookTrustHeader(
        `${managedHooksPath}:permission_request:0:0`
      )
      const legacyPermissionHeader = `[hooks.state."${escapeTomlBasicString(
        `${getCodexExplicitHomeHookSourcePath(managedHooksPath).replace(/\\/g, '/')}:permission_request:0:0`
      )}"]`
      const installedToml = readFileSync(runtimeTomlPath, 'utf-8')
      expect(installedToml).toContain(canonicalPermissionHeader)

      writeFileSync(
        runtimeTomlPath,
        installedToml.replace(canonicalPermissionHeader, legacyPermissionHeader),
        'utf-8'
      )

      const legacyToml = readFileSync(runtimeTomlPath, 'utf-8')
      expect(legacyToml).toContain(legacyPermissionHeader)
      expect(service.getStatus().state).toBe('installed')

      expect((await service.install()).state).toBe('installed')

      const repairedToml = readFileSync(runtimeTomlPath, 'utf-8')
      expect(repairedToml).not.toContain(legacyPermissionHeader)
      expect(repairedToml).toContain(canonicalPermissionHeader)
      expect(service.getStatus().state).toBe('installed')
    }
  )

  it('repairs duplicate managed PermissionRequest trust tables on restart install', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "system-model"\n', 'utf-8')

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

    // Why: preserving `enabled = false` is the repair contract; status can be
    // partial because the user-disabled managed hook remains disabled.
    expect(['installed', 'partial']).toContain((await service.install()).state)

    const repairedToml = readFileSync(runtimeTomlPath, 'utf-8')
    expect(repairedToml.split(permissionRequestHeader)).toHaveLength(2)
    expect(repairedToml).toContain('enabled = false')
    expect(repairedToml).not.toContain('STALE_DISABLED')
    expect(repairedToml).not.toContain('STALE_ENABLED')
    expect(repairedToml).toContain('model = "system-model"')
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

    const status = await new CodexHookService().install()

    expect(status.state).toBe('installed')
    const trustConfig = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(trustConfig).toContain('model = "system-model"')
    expect(trustConfig).toContain('[projects."/repo"]\ntrust_level = "untrusted"')
    expect(trustConfig).toContain('[projects."/runtime-only"]\ntrust_level = "trusted"')
    expect(trustConfig).not.toContain('model = "runtime-model"')
  })
})
