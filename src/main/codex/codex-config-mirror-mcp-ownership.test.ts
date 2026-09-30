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

describe('canonical MCP ownership during config mirroring', () => {
  it('binds mirrored MCP header helpers to each account home', () => {
    const sourceHome = systemHomePath
    const canonical = [
      '[mcp_servers.time]',
      `http_headers_helper = "/usr/bin/env CODEX_HOME=${sourceHome} python headers.py"`,
      '',
      '[mcp_servers.other]',
      'http_headers_helper = "python unrelated.py"',
      ''
    ].join('\n')
    writeFileSync(join(systemHomePath, 'config.toml'), canonical, 'utf-8')
    const firstHome = join(root, 'account homes', 'first', 'home')
    const secondHome = join(root, 'account homes', 'second', 'home')
    for (const runtimeHomePath of [firstHome, secondHome]) {
      mkdirSync(runtimeHomePath, { recursive: true })
      syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath: sourceHome })
      const mirrored = readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')
      expect(mirrored).toContain(`CODEX_HOME='${runtimeHomePath}'`)
      expect(mirrored).toContain('http_headers_helper = "python unrelated.py"')
      expect(mirrored).not.toContain(`CODEX_HOME=${sourceHome}`)
    }
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe(canonical)
  })

  it('does not duplicate a server defined inline in the canonical MCP table', () => {
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      '[mcp_servers.shared]\ncommand = "runtime"\n'
    )
    writeFileSync(
      join(systemHomePath, 'config.toml'),
      '[mcp_servers]\nshared = { command = "system" }\n'
    )

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

    const runtimeConfig = readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')
    expect(runtimeConfig).toContain('shared = { command = "system" }')
    expect(runtimeConfig).not.toContain('[mcp_servers.shared]')
  })

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

  it('honors a closed canonical MCP root and its later removal', () => {
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      '[mcp_servers.runtime_only]\ncommand = "runtime"\n'
    )
    writeFileSync(
      join(systemHomePath, 'config.toml'),
      'mcp_servers = { shared = { enabled = false } }\n'
    )
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).not.toContain(
      '[mcp_servers.'
    )
    expect(
      JSON.parse(
        readFileSync(join(runtimeHomePath, '.orca-config-settings-baseline.json'), 'utf-8')
      )
    ).toMatchObject({ mcpServerRoot: true })
    writeFileSync(join(runtimeHomePath, 'config.toml'), '[mcp_servers.shared]\nenabled = false\n')
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "system"\n')

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).not.toContain(
      '[mcp_servers.'
    )
  })
})

describe('MCP ownership migration', () => {
  it('keeps a pre-ownership baseline canonical for one pass', () => {
    writeFileSync(join(runtimeHomePath, 'config.toml'), '[mcp_servers.removed]\ncommand = "old"\n')
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "system"\n')
    writeFileSync(
      join(runtimeHomePath, '.orca-config-settings-baseline.json'),
      JSON.stringify({ version: 1, settings: {} })
    )

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).not.toContain(
      '[mcp_servers.'
    )
    expect(
      JSON.parse(
        readFileSync(join(runtimeHomePath, '.orca-config-settings-baseline.json'), 'utf-8')
      )
    ).toMatchObject({ mcpServers: [] })
    writeFileSync(join(runtimeHomePath, 'config.toml'), '[mcp_servers.added]\ncommand = "new"\n')

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toContain(
      '[mcp_servers.added]'
    )
  })

  it('keeps the retained shared home one-way without an ownership baseline', () => {
    writeFileSync(join(runtimeHomePath, 'config.toml'), '[mcp_servers.removed]\ncommand = "old"\n')
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "system"\n')

    syncSystemConfigIntoLegacySharedCodexHome({ runtimeHomePath, systemHomePath })

    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).not.toContain(
      '[mcp_servers.'
    )
  })

  it('tracks commented CRLF names so their later removal remains authoritative', () => {
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      '[mcp_servers.shared]\ncommand = "runtime"\n'
    )
    writeFileSync(
      join(systemHomePath, 'config.toml'),
      '[mcp_servers.shared] # see [docs]\r\ncommand = "system"\r\n'
    )

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).not.toContain('"runtime"')
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "system"\n')

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).not.toContain(
      '[mcp_servers.shared]'
    )
  })
})
