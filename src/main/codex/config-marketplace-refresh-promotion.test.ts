import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const MARKETPLACE_CONFIG = [
  '# canonical config',
  'model = "gpt-5"',
  '',
  '[marketplaces.demo]',
  'source_type = "git"',
  'source = "https://github.com/example/demo.git"',
  'ref = "main"',
  'sparse_paths = ["plugins"]',
  'last_updated = "2026-07-01T00:00:00Z" # keep this comment',
  'last_revision = "canonical-revision"',
  'enabled = true',
  '',
  '[features]',
  'hooks = true',
  ''
].join('\r\n')

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-marketplace-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-marketplace-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  mkdirSync(systemHomeDir(), { recursive: true })
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

function systemHomeDir(): string {
  return join(fakeHomeDir, '.codex')
}

function systemConfigPath(): string {
  return join(systemHomeDir(), 'config.toml')
}

function runtimeConfigPath(): string {
  return join(userDataDir, 'codex-runtime-home', 'home', 'config.toml')
}

function writeSystemConfig(content: string): void {
  writeFileSync(systemConfigPath(), content, 'utf-8')
}

function readSystemConfig(): string {
  return readFileSync(systemConfigPath(), 'utf-8')
}

function readRuntimeConfig(): string {
  return readFileSync(runtimeConfigPath(), 'utf-8')
}

function writeRuntimeConfig(content: string): void {
  mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
  writeFileSync(runtimeConfigPath(), content, 'utf-8')
}

function seedMirroredConfig(): void {
  writeSystemConfig(MARKETPLACE_CONFIG)
  syncSystemConfigIntoManagedCodexHome()
  expect(existsSync(runtimeConfigPath())).toBe(true)
}

function setRuntimeMarketplaceMetadata(
  timestamp: string | null,
  revision = 'runtime-revision',
  source = 'https://github.com/example/demo.git'
): void {
  let config = readRuntimeConfig().replace(
    'source = "https://github.com/example/demo.git"',
    `source = "${source}"`
  )
  config = config.replace(
    /last_updated = .*\r?\n/,
    timestamp ? `last_updated = "${timestamp}"\r\n` : ''
  )
  config = config.replace(/last_revision = .*\r?\n/, `last_revision = "${revision}"\r\n`)
  writeRuntimeConfig(config)
}

describe('Codex marketplace refresh promotion through the config mirror', () => {
  it('promotes newer matching metadata, keeps unrelated fields, and is idempotent', () => {
    seedMirroredConfig()
    setRuntimeMarketplaceMetadata('2026-07-02T00:00:00Z')
    writeRuntimeConfig(readRuntimeConfig().replace('enabled = true', 'enabled = false'))

    syncSystemConfigIntoManagedCodexHome()

    const promoted = readSystemConfig()
    expect(promoted).toContain('last_updated = "2026-07-02T00:00:00Z" # keep this comment')
    expect(promoted).toContain('last_revision = "runtime-revision"')
    expect(promoted).toContain('source = "https://github.com/example/demo.git"')
    expect(promoted).toContain('enabled = true')
    expect(promoted).toContain('model = "gpt-5"')
    expect(promoted).toContain('[features]\r\nhooks = true')

    const settledSystem = readSystemConfig()
    const settledRuntime = readRuntimeConfig()
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toBe(settledSystem)
    expect(readRuntimeConfig()).toBe(settledRuntime)
  })

  it.each([
    ['equal', '2026-07-01T00:00:00Z'],
    ['older', '2026-06-30T00:00:00Z'],
    ['malformed', 'not-a-timestamp']
  ])('preserves canonical metadata for an %s runtime timestamp', (_label, timestamp) => {
    seedMirroredConfig()
    const before = readSystemConfig()
    setRuntimeMarketplaceMetadata(timestamp)

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(before)
  })

  it('preserves canonical metadata when the runtime timestamp is missing', () => {
    seedMirroredConfig()
    const before = readSystemConfig()
    setRuntimeMarketplaceMetadata(null)

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(before)
  })

  it('preserves canonical metadata when the marketplace identity changes', () => {
    seedMirroredConfig()
    const before = readSystemConfig()
    setRuntimeMarketplaceMetadata(
      '2026-07-02T00:00:00Z',
      'runtime-revision',
      'https://example.com/other.git'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(before)
    expect(readRuntimeConfig()).toContain('source = "https://github.com/example/demo.git"')
  })

  it('inserts last_revision after last_updated when the canonical marketplace lacks it', () => {
    writeSystemConfig(MARKETPLACE_CONFIG.replace('last_revision = "canonical-revision"\r\n', ''))
    syncSystemConfigIntoManagedCodexHome()
    expect(existsSync(runtimeConfigPath())).toBe(true)
    writeRuntimeConfig(
      readRuntimeConfig().replace(
        /last_updated = .*\r?\n/,
        'last_updated = "2026-07-02T00:00:00Z"\r\nlast_revision = "runtime-revision"\r\n'
      )
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain(
      'last_updated = "2026-07-02T00:00:00Z" # keep this comment\r\nlast_revision = "runtime-revision"\r\nenabled = true'
    )
  })

  it('does not restore a runtime-only marketplace or a removed canonical marketplace', () => {
    seedMirroredConfig()
    writeRuntimeConfig(
      `${readRuntimeConfig()}\r\n[marketplaces.runtime_only]\r\nsource_type = "git"\r\nsource = "https://github.com/example/runtime.git"\r\nlast_updated = "2026-07-02T00:00:00Z"\r\nlast_revision = "runtime-only"\r\n`
    )
    writeSystemConfig(
      MARKETPLACE_CONFIG.replace(
        /\r?\n\[marketplaces\.demo\][\s\S]*?\r?\n\[features\]/,
        '\r\n[features]'
      )
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).not.toContain('[marketplaces.')
    expect(readRuntimeConfig()).not.toContain('[marketplaces.')
  })
})
