import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncHostMcpServers, type HostMcpSyncPaths } from './host-mcp-sync'

let dir: string
let paths: HostMcpSyncPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-sync-'))
  paths = {
    claudeConfig: join(dir, '.claude.json'),
    codexConfig: join(dir, '.codex', 'config.toml'),
    ledger: join(dir, 'userData', 'mcp-sync-ledger.json')
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const deps = () => ({
  paths,
  commandExists: async (command: string) => command === 'npx',
  resolves: async (hostname: string) => hostname !== 'blocked.example'
})

describe('syncHostMcpServers', () => {
  it('writes owner-only configs, skips commands the host lacks and flags unresolvable hosts', async () => {
    writeFileSync(paths.claudeConfig, JSON.stringify({ userID: 'u' }), { mode: 0o644 })
    const result = await syncHostMcpServers(
      {
        claude: {
          fs: { command: 'npx', args: ['-y', 'server-fs'], env: { TOKEN: 'secret' } },
          py: { command: 'uvx', args: ['mcp-server-fetch'] },
          remote: { type: 'http', url: 'https://blocked.example/mcp' }
        },
        codex: { fs: { command: 'npx' } }
      },
      deps()
    )
    expect(result).toEqual({
      claude: { py: 'command-missing', fs: 'added', remote: 'added' },
      codex: { fs: 'added' },
      unreachableHosts: ['blocked.example']
    })
    expect(JSON.parse(readFileSync(paths.claudeConfig, 'utf8'))).toEqual({
      userID: 'u',
      mcpServers: {
        fs: { command: 'npx', args: ['-y', 'server-fs'], env: { TOKEN: 'secret' } },
        remote: { type: 'http', url: 'https://blocked.example/mcp' }
      }
    })
    for (const path of [paths.claudeConfig, paths.codexConfig, paths.ledger]) {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(readFileSync(paths.ledger, 'utf8')).not.toContain('secret')
  })

  it('reports unchanged on a repeat sync and removes only its own servers when they stop coming', async () => {
    await syncHostMcpServers({ claude: { fs: { command: 'npx' } }, codex: {} }, deps())
    const claude = JSON.parse(readFileSync(paths.claudeConfig, 'utf8'))
    claude.mcpServers.mine = { command: 'host-only' }
    writeFileSync(paths.claudeConfig, JSON.stringify(claude))
    const again = await syncHostMcpServers({ claude: { fs: { command: 'npx' } } }, deps())
    expect(again.claude).toEqual({ fs: 'unchanged' })
    await syncHostMcpServers({ claude: {} }, deps())
    expect(JSON.parse(readFileSync(paths.claudeConfig, 'utf8')).mcpServers).toEqual({
      mine: { command: 'host-only' }
    })
  })

  it('two computers syncing one shared sandbox keep each other’s servers (no flapping)', async () => {
    const a = {
      claude: { fromA: { command: 'npx' } },
      codex: { fromA: { command: 'npx' } },
      syncer: 'aaaa'
    }
    const b = {
      claude: { fromB: { command: 'npx' } },
      codex: { fromB: { command: 'npx' } },
      syncer: 'bbbb'
    }
    await syncHostMcpServers(a, deps())
    await syncHostMcpServers(b, deps())
    const again = await syncHostMcpServers(a, deps())
    expect(again.claude).toEqual({ fromA: 'unchanged' })
    expect(again.codex).toEqual({ fromA: 'unchanged' })
    expect(
      Object.keys(JSON.parse(readFileSync(paths.claudeConfig, 'utf8')).mcpServers).sort()
    ).toEqual(['fromA', 'fromB'])
    const toml = readFileSync(paths.codexConfig, 'utf8')
    expect(toml).toContain('[aaaa]')
    expect(toml).toContain('[bbbb]')
    // A stops syncing fromA: only A's entry goes.
    await syncHostMcpServers({ claude: {}, codex: {}, syncer: 'aaaa' }, deps())
    expect(Object.keys(JSON.parse(readFileSync(paths.claudeConfig, 'utf8')).mcpServers)).toEqual([
      'fromB'
    ])
    expect(readFileSync(paths.codexConfig, 'utf8')).not.toContain('fromA')
  })

  it('the first computer with an id takes over what the shared ledger wrote, once', async () => {
    await syncHostMcpServers(
      { claude: { old: { command: 'npx' } }, codex: { old: { command: 'npx' } } },
      deps()
    )
    const adopted = await syncHostMcpServers(
      { claude: { old: { command: 'npx' } }, codex: { old: { command: 'npx' } }, syncer: 'cccc' },
      deps()
    )
    expect(adopted.claude).toEqual({ old: 'unchanged' })
    expect(adopted.codex).toEqual({ old: 'unchanged' })
    const toml = readFileSync(paths.codexConfig, 'utf8')
    expect(toml.match(/mcp_servers\.old/g)).toHaveLength(1)
    expect(toml).toContain('[cccc]')
    // Removing works through the adopted ledger.
    await syncHostMcpServers({ claude: {}, codex: {}, syncer: 'cccc' }, deps())
    expect(JSON.parse(readFileSync(paths.claudeConfig, 'utf8')).mcpServers ?? {}).toEqual({})
  })
})
