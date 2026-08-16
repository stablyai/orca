import { describe, expect, it } from 'vitest'
import type { McpConfigCandidate } from '../../shared/mcp-config'
import { inspectCodexMcpToml } from './codex-mcp-toml'

const candidate: McpConfigCandidate = {
  format: 'workspace',
  label: 'Codex',
  relativePath: '.codex/config.toml',
  serversPath: ['mcp_servers']
}

describe('inspectCodexMcpToml', () => {
  it('reports a missing file without servers', () => {
    expect(inspectCodexMcpToml(candidate, null)).toEqual({
      candidate,
      exists: false,
      status: 'missing',
      servers: []
    })
  })

  it('reads stdio and http servers, quoted names, disabled flags and comments', () => {
    const toml = [
      'model = "gpt-5" # unrelated top-level key',
      '',
      '[mcp_servers.linear]',
      'command = "npx"',
      'args = ["-y", "@linear/mcp"] # inline comment',
      '',
      '[mcp_servers."my server"]',
      "url = 'https://example.test/mcp#frag'",
      'enabled = false',
      '',
      '[projects."/some/path"]',
      'command = "should-not-leak"',
      ''
    ].join('\r\n')
    const result = inspectCodexMcpToml(candidate, toml)
    expect(result.status).toBe('valid')
    expect(result.servers).toEqual([
      expect.objectContaining({
        name: 'linear',
        transport: 'stdio',
        status: 'enabled',
        command: 'npx'
      }),
      expect.objectContaining({
        name: 'my server',
        transport: 'http',
        status: 'disabled',
        url: 'https://example.test/mcp#frag'
      })
    ])
  })

  it('keeps reading after multi-line arrays and env sub-tables', () => {
    const toml = [
      '[mcp_servers.gh]',
      'command = "docker"',
      'args = [',
      '  "run",',
      '  "-i", # keep stdin',
      '  "ghcr.io/github/github-mcp-server"',
      ']',
      '',
      '[mcp_servers.gh.env]',
      'GITHUB_TOKEN = "ghp_123456789012345678"',
      '',
      '[mcp_servers.second]',
      'command = "uvx"',
      'args = ["thing"]',
      ''
    ].join('\n')
    const result = inspectCodexMcpToml(candidate, toml)
    expect(result.servers.map((server) => [server.name, server.status])).toEqual([
      ['gh', 'enabled'],
      ['second', 'enabled']
    ])
    expect(result.servers[0].env).toEqual({ GITHUB_TOKEN: expect.not.stringContaining('123456') })
  })

  it('marks a table without command or url as invalid rather than dropping it', () => {
    const result = inspectCodexMcpToml(candidate, '[mcp_servers.broken]\nenabled = true\n')
    expect(result.servers).toEqual([expect.objectContaining({ name: 'broken', status: 'invalid' })])
  })
})
