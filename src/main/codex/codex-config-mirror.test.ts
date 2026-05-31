/* eslint-disable max-lines -- Why: these cases exercise one stateful Codex
config sync contract across first-run, upgrade, corrupt-state, and trust
preservation paths. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function getSystemCodexHomePath(): string {
  return join(fakeHomeDir, '.codex')
}

function getSystemConfigPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}

function getRuntimeConfigPath(): string {
  return join(userDataDir, 'codex-runtime-home', 'home', 'config.toml')
}

function getConfigSyncStatePath(): string {
  return join(userDataDir, 'codex-runtime-home', 'config-sync-state.json')
}

function establishSystemConfigBaseline(config: string): void {
  writeFileSync(getSystemConfigPath(), config, 'utf-8')
  syncSystemConfigIntoManagedCodexHome()
}

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-config-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-config-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  mkdirSync(getSystemCodexHomePath(), { recursive: true })
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('syncSystemConfigIntoManagedCodexHome', () => {
  it('seeds a missing runtime config without copying system hook trust', () => {
    writeFileSync(
      getSystemConfigPath(),
      [
        'model = "system-model"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:system"',
        '',
        '[projects."/repo"]',
        'trust_level = "trusted"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "system-model"')
    expect(runtimeConfig).toContain('[projects."/repo"]')
    expect(runtimeConfig).not.toContain('[hooks.state."system-hooks:stop:0:0"]')
  })

  it('treats whitespace-formatted hook trust headers as runtime-owned', () => {
    writeFileSync(
      getSystemConfigPath(),
      [
        'model = "system-model"',
        '',
        '["hooks" . "state" . "system-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:system"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "runtime-model"',
        '',
        '["hooks" . "state" . "runtime-hooks:stop:0:0"]',
        'enabled = false',
        'trusted_hash = "sha256:runtime"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(getSystemConfigPath(), 'model = "next-system-model"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "next-system-model"')
    expect(runtimeConfig).toContain('["hooks" . "state" . "runtime-hooks:stop:0:0"]')
    expect(runtimeConfig).toContain('trusted_hash = "sha256:runtime"')
    expect(runtimeConfig).not.toContain('["hooks" . "state" . "system-hooks:stop:0:0"]')
    expect(runtimeConfig).not.toContain('trusted_hash = "sha256:system"')
  })

  it('normalizes deprecated codex_hooks feature flag only in runtime config', () => {
    writeFileSync(
      getSystemConfigPath(),
      ['model = "system-model"', '', '[features]', 'codex_hooks = true', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('[features]\nhooks = true')
    expect(runtimeConfig).not.toContain('codex_hooks')
    expect(readFileSync(getSystemConfigPath(), 'utf-8')).toContain('codex_hooks = true')
  })

  it('drops deprecated codex_hooks when the new hooks flag already exists', () => {
    writeFileSync(
      getSystemConfigPath(),
      ['[features]', 'hooks = true', 'codex_hooks = true', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('[features]\nhooks = true')
    expect(runtimeConfig).not.toContain('codex_hooks')
  })

  it('mirrors system config updates while preserving runtime-owned trust sections', () => {
    establishSystemConfigBaseline('model = "initial-system-model"\n')
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "runtime-model"',
        '',
        '[hooks.state."runtime-hooks:stop:0:0"]',
        'enabled = false',
        'trusted_hash = "sha256:runtime"',
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
    writeFileSync(
      getSystemConfigPath(),
      [
        'model = "system-model"',
        '',
        '[projects."/repo"] # explicit revocation',
        'trust_level = "untrusted"',
        '',
        '[projects."/system-only"]',
        'trust_level = "trusted"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:system"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "system-model"')
    expect(runtimeConfig).not.toContain('model = "runtime-model"')
    expect(runtimeConfig).toContain('[projects."/repo"]')
    expect(runtimeConfig).toContain('[projects."/runtime-only"]')
    expect(runtimeConfig).toContain('[projects."/system-only"]')
    expect(runtimeConfig).toContain('[hooks.state."runtime-hooks:stop:0:0"]')
    expect(runtimeConfig).not.toContain('[hooks.state."system-hooks:stop:0:0"]')
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig.match(/\[projects\."\/repo"\]/g)?.length).toBe(1)
  })

  it('keeps runtime Codex preference changes when the system config has not changed', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getSystemConfigPath(), 'model = "system-model"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')
  })

  it('keeps runtime Codex preference changes when the system config is missing', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')
  })

  it('keeps runtime preferences on first baseline while honoring system project trust', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getSystemConfigPath(),
      [
        'model = "system-model"',
        '',
        '[projects."/repo"] # explicit revocation',
        'trust_level = "untrusted"',
        '',
        '[projects."/system-only"]',
        'trust_level = "trusted"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:system"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "runtime-model"',
        '',
        '[projects."/repo"]',
        'trust_level = "trusted"',
        'metadata = "runtime-owned"',
        '',
        '[projects."/runtime-only"]',
        'trust_level = "trusted"',
        '',
        '[hooks.state."runtime-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:runtime"',
        ''
      ].join('\n'),
      'utf-8'
    )
    utimesSync(
      getSystemConfigPath(),
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-01T00:00:00Z')
    )
    utimesSync(
      getRuntimeConfigPath(),
      new Date('2024-01-01T00:01:00Z'),
      new Date('2024-01-01T00:01:00Z')
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "runtime-model"')
    expect(runtimeConfig).not.toContain('model = "system-model"')
    expect(runtimeConfig).toContain('[projects."/repo"]')
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig).toContain('metadata = "runtime-owned"')
    expect(runtimeConfig).toContain('[projects."/runtime-only"]')
    expect(runtimeConfig).toContain('[projects."/system-only"]')
    expect(runtimeConfig).toContain('[hooks.state."runtime-hooks:stop:0:0"]')
    expect(runtimeConfig).not.toContain('[hooks.state."system-hooks:stop:0:0"]')
    expect(runtimeConfig.match(/\[projects\."\/repo"\]/g)?.length).toBe(1)

    writeFileSync(getSystemConfigPath(), 'model = "next-system-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    const updatedRuntimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(updatedRuntimeConfig).toContain('model = "next-system-model"')
    expect(updatedRuntimeConfig).not.toContain('model = "runtime-model"')
    expect(updatedRuntimeConfig).toContain('[projects."/runtime-only"]')
    expect(updatedRuntimeConfig).toContain('[hooks.state."runtime-hooks:stop:0:0"]')
  })

  it('baselines skipped no-baseline system settings until their contents change', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getSystemConfigPath(), 'model = "system-model"\n', 'utf-8')
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    utimesSync(
      getSystemConfigPath(),
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-01T00:00:00Z')
    )
    utimesSync(
      getRuntimeConfigPath(),
      new Date('2024-01-01T00:01:00Z'),
      new Date('2024-01-01T00:01:00Z')
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')
    expect(readFileSync(getConfigSyncStatePath(), 'utf-8')).toMatch(
      /"lastMirrorableSystemConfigDigest": "sha256:[a-f0-9]{64}"/
    )

    utimesSync(
      getSystemConfigPath(),
      new Date('2024-01-01T00:02:00Z'),
      new Date('2024-01-01T00:02:00Z')
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')

    writeFileSync(getSystemConfigPath(), 'model = "next-system-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "next-system-model"\n')
  })

  it('keeps runtime preferences when only system project trust changes', () => {
    establishSystemConfigBaseline('model = "system-model"\n')
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    writeFileSync(
      getSystemConfigPath(),
      [
        'model = "system-model"',
        '',
        '[projects."/new-system-project"]',
        'trust_level = "trusted"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:system"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "runtime-model"')
    expect(runtimeConfig).toContain('[projects."/new-system-project"]')
    expect(runtimeConfig).not.toContain('[hooks.state."system-hooks:stop:0:0"]')
  })

  it('keeps runtime preferences when an unrelated ordinary system section changes', () => {
    establishSystemConfigBaseline('model = "system-model"\n')
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    writeFileSync(
      getSystemConfigPath(),
      [
        'model = "system-model"',
        '',
        '[mcp_servers.files]',
        'command = "node"',
        'args = ["server.js"]',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "runtime-model"')
    expect(runtimeConfig).toContain('[mcp_servers.files]')
    expect(runtimeConfig).toContain('command = "node"')
    expect(runtimeConfig).not.toContain('model = "system-model"')
  })

  it('matches equivalent ordinary table headers before merging system sections', () => {
    establishSystemConfigBaseline(
      ['model = "system-model"', '', '[mcp_servers.files]', 'command = "node"', ''].join('\n')
    )
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "runtime-model"',
        '',
        '[mcp_servers.files]',
        'command = "node"',
        'args = ["runtime.js"]',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      ['model = "system-model"', '', '[mcp_servers . files]', 'command = "node"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "runtime-model"')
    expect(runtimeConfig).toContain('[mcp_servers.files]')
    expect(runtimeConfig).toContain('args = ["runtime.js"]')
    expect(runtimeConfig).not.toContain('[mcp_servers . files]')
    expect(runtimeConfig.match(/mcp_servers/g)?.length).toBe(1)
  })

  it('keeps changed top-level settings before TOML table sections', () => {
    establishSystemConfigBaseline(
      ['model = "system-model"', '', '[mcp_servers.files]', 'command = "node"', ''].join('\n')
    )
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "runtime-model"',
        '',
        'model_reasoning_effort = "low"',
        '',
        '[mcp_servers.files]',
        'command = "node"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      ['model = "next-system-model"', '', '[mcp_servers.files]', 'command = "node"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "next-system-model"')
    expect(runtimeConfig.indexOf('model = "next-system-model"')).toBeLessThan(
      runtimeConfig.indexOf('[mcp_servers.files]')
    )
  })

  it('keeps runtime preferences when the system config is deleted after a baseline', () => {
    establishSystemConfigBaseline('model = "system-model"\n')
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    rmSync(getSystemConfigPath(), { force: true })

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')
  })

  it('keeps runtime-edited settings when a deleted system config reappears unchanged', () => {
    establishSystemConfigBaseline('model = "system-model"\n')
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    rmSync(getSystemConfigPath(), { force: true })

    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(getSystemConfigPath(), 'model = "system-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')
  })

  it('removes unchanged mirrored settings when the system config is deleted', () => {
    establishSystemConfigBaseline(
      ['model = "system-model"', 'model_reasoning_effort = "high"', ''].join('\n')
    )
    rmSync(getSystemConfigPath(), { force: true })

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('')
  })

  it('keeps a migrated legacy baseline when system config is temporarily missing', () => {
    const systemConfig = 'model = "system-model"\n'
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    writeFileSync(
      getConfigSyncStatePath(),
      `${JSON.stringify({ lastSystemConfig: systemConfig }, null, 2)}\n`,
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')
    expect(readFileSync(getConfigSyncStatePath(), 'utf-8')).toContain('lastSystemConfigUnitDigests')

    writeFileSync(getSystemConfigPath(), systemConfig, 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')

    writeFileSync(getSystemConfigPath(), 'model = "next-system-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "next-system-model"\n')
  })

  it('defers digest-only state migration while system config is temporarily missing', () => {
    const systemConfig = 'model = "system-model"\n'
    establishSystemConfigBaseline(systemConfig)
    const state = JSON.parse(readFileSync(getConfigSyncStatePath(), 'utf-8')) as {
      lastMirrorableSystemConfigDigest: string
    }
    writeFileSync(
      getConfigSyncStatePath(),
      `${JSON.stringify(
        { lastMirrorableSystemConfigDigest: state.lastMirrorableSystemConfigDigest },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    rmSync(getSystemConfigPath(), { force: true })

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')

    writeFileSync(getSystemConfigPath(), systemConfig, 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')
    expect(readFileSync(getConfigSyncStatePath(), 'utf-8')).toContain('lastSystemConfigUnitDigests')
  })

  it('applies system changes when digest-only state proves runtime still matches baseline', () => {
    const systemConfig = 'model = "system-model"\n'
    establishSystemConfigBaseline(systemConfig)
    const state = JSON.parse(readFileSync(getConfigSyncStatePath(), 'utf-8')) as {
      lastMirrorableSystemConfigDigest: string
    }
    writeFileSync(
      getConfigSyncStatePath(),
      `${JSON.stringify(
        { lastMirrorableSystemConfigDigest: state.lastMirrorableSystemConfigDigest },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(getSystemConfigPath(), 'model = "next-system-model"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "next-system-model"\n')
    expect(readFileSync(getConfigSyncStatePath(), 'utf-8')).toContain('lastSystemConfigUnitDigests')
  })

  it('baselines digest-only recovery after preserving ambiguous runtime edits', () => {
    const systemConfig = 'model = "system-model"\n'
    establishSystemConfigBaseline(systemConfig)
    const state = JSON.parse(readFileSync(getConfigSyncStatePath(), 'utf-8')) as {
      lastMirrorableSystemConfigDigest: string
    }
    writeFileSync(
      getConfigSyncStatePath(),
      `${JSON.stringify(
        { lastMirrorableSystemConfigDigest: state.lastMirrorableSystemConfigDigest },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    writeFileSync(getSystemConfigPath(), 'model = "current-system-model"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')

    writeFileSync(getSystemConfigPath(), 'model = "next-system-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "next-system-model"\n')
  })

  it('rewrites hybrid legacy sync state without keeping sensitive system config contents', () => {
    const systemConfig = 'model = "system-model"\napi_key = "sk-sensitive-value"\n'
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), systemConfig, 'utf-8')
    writeFileSync(getSystemConfigPath(), systemConfig, 'utf-8')
    syncSystemConfigIntoManagedCodexHome()
    const stateWithDigest = JSON.parse(readFileSync(getConfigSyncStatePath(), 'utf-8')) as {
      lastMirrorableSystemConfigDigest: string
    }
    writeFileSync(
      getConfigSyncStatePath(),
      `${JSON.stringify({ ...stateWithDigest, lastSystemConfig: systemConfig }, null, 2)}\n`,
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const state = readFileSync(getConfigSyncStatePath(), 'utf-8')
    expect(state).toContain('lastMirrorableSystemConfigDigest')
    expect(state).toMatch(/sha256:[a-f0-9]{64}/)
    expect(state).not.toContain('sk-sensitive-value')
    expect(state).not.toContain('api_key')
    expect(Object.hasOwn(JSON.parse(state) as Record<string, unknown>, 'lastSystemConfig')).toBe(
      false
    )
  })

  it('rewrites hybrid sync state with a non-string legacy key', () => {
    const systemConfig = 'model = "system-model"\n'
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), systemConfig, 'utf-8')
    writeFileSync(getSystemConfigPath(), systemConfig, 'utf-8')
    syncSystemConfigIntoManagedCodexHome()
    const stateWithDigest = JSON.parse(readFileSync(getConfigSyncStatePath(), 'utf-8')) as {
      lastMirrorableSystemConfigDigest: string
    }
    writeFileSync(
      getConfigSyncStatePath(),
      `${JSON.stringify({ ...stateWithDigest, lastSystemConfig: { token: 'sk-sensitive-value' } }, null, 2)}\n`,
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const parsed = JSON.parse(readFileSync(getConfigSyncStatePath(), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(parsed.lastMirrorableSystemConfigDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(Object.hasOwn(parsed, 'lastSystemConfig')).toBe(false)
  })

  it('keeps runtime preferences when the first sync baseline is missing', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "stale-runtime-model"',
        '',
        '[hooks.state."runtime-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:runtime"',
        '',
        '[projects."/system-project"]',
        'trust_level = "trusted"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      [
        'model = "new-system-model"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:system"',
        '',
        '[projects."/system-project"]',
        'trust_level = "untrusted"',
        ''
      ].join('\n'),
      'utf-8'
    )
    utimesSync(
      getRuntimeConfigPath(),
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-01T00:00:00Z')
    )
    utimesSync(
      getSystemConfigPath(),
      new Date('2024-01-01T00:01:00Z'),
      new Date('2024-01-01T00:01:00Z')
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "stale-runtime-model"')
    expect(runtimeConfig).not.toContain('model = "new-system-model"')
    expect(runtimeConfig).toContain('[hooks.state."runtime-hooks:stop:0:0"]')
    expect(runtimeConfig).not.toContain('[hooks.state."system-hooks:stop:0:0"]')
    expect(runtimeConfig).toContain('[projects."/system-project"]')
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
  })

  it('updates project trust when the system project trust changes from untrusted to trusted', () => {
    establishSystemConfigBaseline(
      ['model = "system-model"', '', '[projects."/repo"]', 'trust_level = "untrusted"', ''].join(
        '\n'
      )
    )
    writeFileSync(getSystemConfigPath(), '[projects."/repo"]\ntrust_level = "trusted"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('[projects."/repo"]')
    expect(runtimeConfig).toContain('trust_level = "trusted"')
    expect(runtimeConfig).not.toContain('trust_level = "untrusted"')
  })

  it('updates project trust without removing runtime-owned project settings', () => {
    establishSystemConfigBaseline(['[projects."/repo"]', 'trust_level = "trusted"', ''].join('\n'))
    writeFileSync(
      getRuntimeConfigPath(),
      ['[projects."/repo"]', 'trust_level = "trusted"', 'metadata = "runtime-owned"', ''].join(
        '\n'
      ),
      'utf-8'
    )
    writeFileSync(getSystemConfigPath(), '[projects."/repo"]\ntrust_level = "untrusted"\n')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('[projects."/repo"]')
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig).toContain('metadata = "runtime-owned"')
    expect(runtimeConfig).not.toContain('trust_level = "trusted"')
  })

  it('applies system trusted project state during missing-baseline recovery', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), '[projects."/repo"]\ntrust_level = "untrusted"\n')
    writeFileSync(getSystemConfigPath(), '[projects."/repo"]\ntrust_level = "trusted"\n')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('[projects."/repo"]')
    expect(runtimeConfig).toContain('trust_level = "trusted"')
    expect(runtimeConfig).not.toContain('trust_level = "untrusted"')
  })

  it('matches equivalent quoted project headers before applying system untrust', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      ["[projects . 'C:\\Repo']", 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      ['[projects."c:/repo"]', 'trust_level = "untrusted"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain("[projects . 'C:\\Repo']")
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig).not.toContain('[projects."c:/repo"]')
    expect(runtimeConfig.match(/trust_level/g)?.length).toBe(1)
  })

  it('tracks duplicate array-table sections by occurrence', () => {
    establishSystemConfigBaseline(
      [
        '[[hooks.PermissionRequest]]',
        'command = "first"',
        '',
        '[[hooks.PermissionRequest]]',
        'command = "second"',
        ''
      ].join('\n')
    )
    writeFileSync(
      getSystemConfigPath(),
      [
        '[[hooks.PermissionRequest]]',
        'command = "first"',
        '',
        '[[hooks.PermissionRequest]]',
        'command = "updated-second"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('command = "first"')
    expect(runtimeConfig).toContain('command = "updated-second"')
    expect(runtimeConfig).not.toContain('command = "second"')
    expect(runtimeConfig.match(/\[\[hooks\.PermissionRequest\]\]/g)?.length).toBe(2)
  })

  it('preserves duplicate array-table order when an earlier occurrence changes', () => {
    establishSystemConfigBaseline(
      [
        '[[hooks.PermissionRequest]]',
        'command = "first"',
        '',
        '[[hooks.PermissionRequest]]',
        'command = "second"',
        ''
      ].join('\n')
    )
    writeFileSync(
      getSystemConfigPath(),
      [
        '[[hooks.PermissionRequest]]',
        'command = "updated-first"',
        '',
        '[[hooks.PermissionRequest]]',
        'command = "second"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('command = "updated-first"')
    expect(runtimeConfig).toContain('command = "second"')
    expect(runtimeConfig).not.toContain('command = "first"')
    expect(runtimeConfig.indexOf('command = "updated-first"')).toBeLessThan(
      runtimeConfig.indexOf('command = "second"')
    )
    expect(runtimeConfig.match(/\[\[hooks\.PermissionRequest\]\]/g)?.length).toBe(2)
  })

  it('recovers a corrupt sync state with newer system mtime without clobbering runtime preferences', () => {
    writeFileSync(getSystemConfigPath(), 'model = "system-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    writeFileSync(getConfigSyncStatePath(), '{not-json', 'utf-8')
    utimesSync(
      getRuntimeConfigPath(),
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-01T00:00:00Z')
    )
    utimesSync(
      getSystemConfigPath(),
      new Date('2024-01-01T00:01:00Z'),
      new Date('2024-01-01T00:01:00Z')
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')
    expect(readFileSync(getConfigSyncStatePath(), 'utf-8')).toMatch(
      /"lastMirrorableSystemConfigDigest": "sha256:[a-f0-9]{64}"/
    )

    writeFileSync(getSystemConfigPath(), 'model = "next-system-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "next-system-model"\n')
  })

  it('recovers an invalid sync-state digest with newer system mtime without clobbering runtime preferences', () => {
    writeFileSync(getSystemConfigPath(), 'model = "system-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(getRuntimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    writeFileSync(
      getConfigSyncStatePath(),
      `${JSON.stringify({ lastMirrorableSystemConfigDigest: 'not-a-digest' }, null, 2)}\n`,
      'utf-8'
    )
    utimesSync(
      getRuntimeConfigPath(),
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-01T00:00:00Z')
    )
    utimesSync(
      getSystemConfigPath(),
      new Date('2024-01-01T00:01:00Z'),
      new Date('2024-01-01T00:01:00Z')
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "runtime-model"\n')
    expect(readFileSync(getConfigSyncStatePath(), 'utf-8')).toMatch(
      /"lastMirrorableSystemConfigDigest": "sha256:[a-f0-9]{64}"/
    )
  })

  it('does not duplicate sensitive system config contents in sync state', () => {
    writeFileSync(
      getSystemConfigPath(),
      'model = "system-model"\napi_key = "sk-sensitive-value"\n',
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const state = readFileSync(getConfigSyncStatePath(), 'utf-8')
    expect(state).toContain('lastMirrorableSystemConfigDigest')
    expect(state).toMatch(/sha256:[a-f0-9]{64}/)
    expect(state).not.toContain('sk-sensitive-value')
    expect(state).not.toContain('api_key')
  })

  it('migrates legacy sync state without keeping sensitive system config contents', () => {
    const systemConfig = 'model = "system-model"\napi_key = "sk-sensitive-value"\n'
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), systemConfig, 'utf-8')
    writeFileSync(getSystemConfigPath(), systemConfig, 'utf-8')
    writeFileSync(
      getConfigSyncStatePath(),
      `${JSON.stringify({ lastSystemConfig: systemConfig }, null, 2)}\n`,
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const state = readFileSync(getConfigSyncStatePath(), 'utf-8')
    expect(state).toContain('lastMirrorableSystemConfigDigest')
    expect(state).toMatch(/sha256:[a-f0-9]{64}/)
    expect(state).not.toContain('sk-sensitive-value')
    expect(state).not.toContain('api_key')
  })

  it('normalizes legacy codex_hooks sync state before comparing digests', () => {
    const systemConfig = [
      'model = "system-model"',
      '',
      '[features]',
      'codex_hooks = true',
      ''
    ].join('\n')
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      ['model = "runtime-model"', '', '[features]', 'hooks = true', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(getSystemConfigPath(), systemConfig, 'utf-8')
    writeFileSync(
      getConfigSyncStatePath(),
      `${JSON.stringify({ lastSystemConfig: systemConfig }, null, 2)}\n`,
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "runtime-model"')
    expect(runtimeConfig).not.toContain('model = "system-model"')
    expect(runtimeConfig).toContain('[features]\nhooks = true')
  })

  it('does not treat TOML table headers inside multiline strings as sections', () => {
    establishSystemConfigBaseline('model = "initial-system-model"\n')
    writeFileSync(
      getRuntimeConfigPath(),
      [
        '[hooks.state."runtime-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:runtime"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      [
        'instructions = """',
        '[hooks.state."inside-basic-string"]',
        'trusted_hash = "not-a-section"',
        '"""',
        '',
        "literal_instructions = '''",
        '[hooks.state."inside-literal-string"]',
        "'''",
        '',
        '[model_providers.openai]',
        'name = "OpenAI"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('[hooks.state."inside-basic-string"]')
    expect(runtimeConfig).toContain('[hooks.state."inside-literal-string"]')
    expect(runtimeConfig).toContain('[model_providers.openai]')
    expect(runtimeConfig).toContain('[hooks.state."runtime-hooks:stop:0:0"]')
  })

  it('does not let triple quotes in comments affect runtime-owned section mirroring', () => {
    establishSystemConfigBaseline('model = "initial-system-model"\n')
    writeFileSync(
      getRuntimeConfigPath(),
      [
        '# example: """ in a comment',
        "# example: ''' in a comment",
        'model = "runtime-model"',
        '',
        '[hooks.state."runtime-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:runtime"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      [
        '# system example: """ in a comment',
        "# system example: ''' in a comment",
        'model = "system-model"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:system"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "system-model"')
    expect(runtimeConfig).toContain('[hooks.state."runtime-hooks:stop:0:0"]')
    expect(runtimeConfig).toContain('trusted_hash = "sha256:runtime"')
    expect(runtimeConfig).not.toContain('[hooks.state."system-hooks:stop:0:0"]')
    expect(runtimeConfig).not.toContain('trusted_hash = "sha256:system"')
  })

  it('does not create a runtime config when neither system nor runtime config exists', () => {
    syncSystemConfigIntoManagedCodexHome()

    expect(existsSync(getRuntimeConfigPath())).toBe(false)
  })
})
