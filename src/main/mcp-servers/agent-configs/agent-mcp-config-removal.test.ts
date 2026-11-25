import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentMcpServerMergeKey } from '../../../shared/mcp/agent-mcp-config-entry'
import { discoverAgentMcpServers } from './agent-mcp-config-read'
import { AgentMcpConfigEditError, removeAgentMcpServerEntries } from './agent-mcp-config-removal'
import {
  listAgentMcpServers,
  moveAgentMcpServer,
  type AgentMcpImportHost
} from './agent-mcp-import'

let home: string
const context = () => ({ homeDir: home, env: {}, platform: 'darwin' as const })
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(home, path)), { recursive: true })
  writeFileSync(join(home, path), text)
}
const read = (path: string) => readFileSync(join(home, path), 'utf8')
const GITHUB = 'https://api.githubcopilot.com/mcp/'

const CLAUDE_JSON = `{
  "numStartups": 4,
  "mcpServers": {
    "github": { "type": "http", "url": "${GITHUB}" },
    "playwright": { "type": "stdio", "command": "npx", "args": ["@playwright/mcp"] }
  },
  "projects": {
    "/work/orca": { "mcpServers": { "db": { "command": "pg-mcp", "args": [] } } },
    "/elsewhere": { "mcpServers": { "lost": { "command": "lost-mcp" } } },
    "/orca-data/bot-tool-sign-in/b1": { "mcpServers": { "bot": { "type": "http", "url": "https://bot.dev/mcp" } } }
  }
}
`
const CODEX_TOML = `# keep me
model = "o3"

[mcp_servers.github]
url = "${GITHUB}"

# about linear
[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
`

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-mcp-import-'))
  write('.claude.json', CLAUDE_JSON)
  write('.codex/config.toml', CODEX_TOML)
  write(
    '.gemini/settings.json',
    '{ "mcpServers": { "figma": { "httpUrl": "https://mcp.figma.com/mcp" }, "sse": { "url": "https://x.dev/sse" } } }'
  )
  write(
    '.config/opencode/opencode.jsonc',
    '{ // v2\n "mcp": { "servers": { "oc": { "type": "local", "command": ["oc-mcp", "-v"], "environment": { "A": "1" } } } } }'
  )
  write(
    '.config/opencode/opencode.json',
    '{ "mcp": { "oc1": { "type": "remote", "url": "https://oc1.dev/mcp", "enabled": false } } }'
  )
  write(
    '.copilot/mcp-config.json',
    '{ "mcpServers": { "cp": { "type": "local", "command": "cp-mcp", "tools": ["*"] } } }'
  )
  write('.pi/agent/mcp.json', '{ "mcpServers": { "pi": { "url": "https://pi.dev/mcp" } } }')
  write('.grok/config.toml', '[mcp_servers.grk]\ncommand = "grk"\nargs = ["a"]\nenabled = false\n')
  write(
    '.cursor/mcp.json',
    '{ "mcpServers": { "cur": { "url": "https://cur.dev/mcp" }, "orca-linear": { "command": "/Applications/Orca.app/Contents/Resources/bin/orca", "args": ["mcp", "connect", "linear"] } } }'
  )
  write(
    '.factory/mcp.json',
    '{ "mcpServers": { "drd": { "type": "http", "url": "https://drd.dev/mcp", "disabled": true } } }'
  )
  write('.config/amp/settings.json', '{ "amp.mcpServers": { "amp": { "command": "amp-mcp" } } }')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('agent MCP config discovery and move', () => {
  it('lists every agent’s own servers, merged by name and URL, without Orca’s own entries', async () => {
    const found = await discoverAgentMcpServers(context(), (path) => path.startsWith('/orca-data/'))
    expect(
      found.map((row) => [
        row.server.name,
        [...new Set(row.sources.map((source) => source.agent))].join(','),
        row.sources.some((source) => source.disabled)
      ])
    ).toEqual([
      ['github', 'claude,codex', false],
      ['playwright', 'claude', false],
      ['db', 'claude', false],
      ['lost', 'claude', false],
      ['linear', 'codex', false],
      ['oc1', 'opencode', true],
      ['oc', 'opencode', false],
      ['figma', 'gemini', false],
      ['cp', 'copilot', false],
      ['pi', 'pi', false],
      ['grk', 'grok', true],
      ['cur', 'cursor', false],
      ['drd', 'droid', true],
      ['amp', 'amp', false]
    ])
    expect(found.find((row) => row.server.name === 'oc')?.server).toEqual({
      name: 'oc',
      command: 'oc-mcp',
      args: ['-v'],
      env: { A: '1' }
    })
  })

  it('moves a server: removes exactly its entries, keeps formatting, and backs each file up', async () => {
    const profile = (id: string, url: string) =>
      write(
        `orca-data/claude-profiles/${id}/home/.claude.json`,
        `{\n  "mcpServers": {\n    "github": { "type": "http", "url": "${url}" },\n    "own": { "command": "own" }\n  }\n}\n`
      )
    profile('same', GITHUB)
    profile('edited', 'https://elsewhere.dev/mcp')
    const host: AgentMcpImportHost = {
      context: context(),
      userDataPath: join(home, 'orca-data'),
      workspaceFor: (path) => (path === '/work/orca' ? { key: 'repo-1', name: 'orca' } : null),
      isOrcaProject: (path) => path.startsWith('/orca-data/')
    }
    const rows = await listAgentMcpServers(host)
    const row = (name: string) => rows.find((found) => found.name === name)!
    expect([row('db').projectNames, row('db').movable]).toEqual([['orca'], true])
    expect([row('lost').projectNames, row('lost').movable]).toEqual([['elsewhere'], false])
    expect(row('github')).toMatchObject({
      agents: ['claude', 'codex'],
      projectNames: [],
      movable: true
    })

    const added: unknown[] = []
    const add = async (...args: unknown[]) => added.push(args)
    await moveAgentMcpServer(host, row('github').key, add)
    await moveAgentMcpServer(host, row('db').key, add)
    expect(added).toEqual([
      [{ name: 'github', url: GITHUB }, null],
      [
        { name: 'db', command: 'pg-mcp', args: [] },
        { later: false, on: ['repo-1'], off: [] }
      ]
    ])
    expect(read('.claude.json')).toBe(
      CLAUDE_JSON.replace(`\n    "github": { "type": "http", "url": "${GITHUB}" },`, '').replace(
        `\n    "/work/orca": { "mcpServers": { "db": { "command": "pg-mcp", "args": [] } } },`,
        `\n    "/work/orca": { "mcpServers": { } },`
      )
    )
    expect(read('.codex/config.toml')).toBe(
      `# keep me\nmodel = "o3"\n\n# about linear\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n`
    )
    expect(read('.codex/config.toml.bak')).toBe(CODEX_TOML)
    expect(read('orca-data/claude-profiles/same/home/.claude.json')).not.toContain('github')
    expect(read('orca-data/claude-profiles/edited/home/.claude.json')).toContain('github')
  })

  it('refuses a file whose entry changed since it was listed', async () => {
    const found = await discoverAgentMcpServers(context(), () => false)
    const github = found.find((row) => row.server.name === 'github')!
    write('.codex/config.toml', CODEX_TOML.replace(GITHUB, 'https://other.dev/mcp'))
    const codex = github.sources.filter((source) => source.agent === 'codex')
    expect(() =>
      removeAgentMcpServerEntries(codex, agentMcpServerMergeKey('github', github.server))
    ).toThrow(AgentMcpConfigEditError)
    expect(read('.codex/config.toml')).toContain('https://other.dev/mcp')
  })
})
