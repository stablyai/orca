import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  syncSystemConfigIntoManagedCodexHome,
  syncSystemConfigIntoLegacySharedCodexHome
} from './codex-config-mirror'

let root: string
let runtimeHomePath: string
let systemHomePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-mcp-ownership-'))
  runtimeHomePath = join(root, 'runtime')
  systemHomePath = join(root, 'system')
  mkdirSync(runtimeHomePath)
  mkdirSync(systemHomePath)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const BASELINE_FILE = '.orca-config-settings-baseline.json'

describe('canonical MCP ownership during config mirroring', () => {
  it('preserves deletion after a canonical inline server is rewritten by the runtime', () => {
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      '[mcp_servers.shared]\ncommand = "runtime"\n'
    )
    writeFileSync(
      join(systemHomePath, 'config.toml'),
      '[mcp_servers]\nshared = { command = "system" }\n'
    )
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      '[mcp_servers.shared]\ncommand = "system"\n[mcp_servers.runtime_only]\ncommand = "runtime"\n'
    )
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "system"\n')

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

    const runtimeConfig = readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')
    expect(runtimeConfig).not.toContain('[mcp_servers.shared]')
    expect(runtimeConfig).toContain('[mcp_servers.runtime_only]')
  })
})

describe('MCP ownership migration', () => {
  it('leaves the retained shared home untouched when its baseline cannot be read', () => {
    const runtimeConfig = 'model = "retained"\n[mcp_servers.demo-mcp]\ncommand = "orca-only"\n'
    writeFileSync(join(runtimeHomePath, 'config.toml'), runtimeConfig)
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "system"\n')
    mkdirSync(join(runtimeHomePath, BASELINE_FILE))

    expect(() =>
      syncSystemConfigIntoLegacySharedCodexHome({ runtimeHomePath, systemHomePath })
    ).toThrow()

    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(runtimeConfig)
  })
})
