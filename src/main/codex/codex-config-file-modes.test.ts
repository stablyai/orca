import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import {
  promoteCodexRuntimeSettingsToSystem,
  snapshotCodexRuntimeSettingsBaseline
} from './config-settings-promotion'
import { upsertProjectTrustLevel } from './config-toml-trust'

const MCP_CONFIG = '[mcp_servers.docs]\ncommand = "docs"\nenv = { API_TOKEN = "secret" }\n'

let root: string
let runtimeHomePath: string
let systemHomePath: string

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-config-modes-'))
  runtimeHomePath = join(root, 'runtime')
  systemHomePath = join(root, '.codex')
  mkdirSync(runtimeHomePath, { recursive: true })
  mkdirSync(systemHomePath, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// Why: POSIX permission bits are what this guards; Windows ignores them.
describe.skipIf(process.platform === 'win32')('Codex config.toml file modes', () => {
  it('creates a fresh runtime mirror owner-only', () => {
    writeFileSync(join(systemHomePath, 'config.toml'), MCP_CONFIG)

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toContain('API_TOKEN')
    expect(modeOf(join(runtimeHomePath, 'config.toml'))).toBe(0o600)
  })

  it('tightens an existing world-readable runtime mirror when it rewrites it', () => {
    writeFileSync(join(systemHomePath, 'config.toml'), MCP_CONFIG)
    writeFileSync(join(runtimeHomePath, 'config.toml'), 'model = "old"\n')
    chmodSync(join(runtimeHomePath, 'config.toml'), 0o644)

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toContain('API_TOKEN')
    expect(modeOf(join(runtimeHomePath, 'config.toml'))).toBe(0o600)
  })

  it('creates a missing config.toml owner-only when recording project trust', () => {
    const configPath = join(systemHomePath, 'config.toml')

    upsertProjectTrustLevel(configPath, '/repo', 'trusted')

    expect(readFileSync(configPath, 'utf-8')).toContain('[projects."/repo"]')
    expect(modeOf(configPath)).toBe(0o600)
  })

  it('keeps an existing config.toml mode when recording project trust', () => {
    const configPath = join(systemHomePath, 'config.toml')
    writeFileSync(configPath, 'model = "gpt-5"\n')
    chmodSync(configPath, 0o700)

    upsertProjectTrustLevel(configPath, '/repo', 'trusted')

    expect(modeOf(configPath)).toBe(0o700)
  })

  it('creates a missing ~/.codex/config.toml owner-only when promoting a setting', () => {
    const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
    writeFileSync(runtimeConfigPath, '')
    snapshotCodexRuntimeSettingsBaseline(runtimeHomePath)
    writeFileSync(runtimeConfigPath, 'model = "gpt-5"\n')

    promoteCodexRuntimeSettingsToSystem({ runtimeHomePath, systemHomePath })

    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toContain('gpt-5')
    expect(modeOf(join(systemHomePath, 'config.toml'))).toBe(0o600)
  })
})
