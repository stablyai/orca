import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  filterAcpMcpServersByCapabilities,
  resolveAcpLaunchMcpServers
} from './acp-structured-launch-mcp'

afterEach(() => {
  vi.restoreAllMocks()
})

function workspaceWithConfig(config: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-acp-launch-mcp-'))
  if (config !== null) {
    writeFileSync(join(dir, '.mcp.json'), config)
  }
  return dir
}

describe('resolveAcpLaunchMcpServers', () => {
  it('passes no servers when the workspace has no MCP config', async () => {
    const cwd = workspaceWithConfig(null)
    try {
      expect(await resolveAcpLaunchMcpServers(cwd)).toEqual([])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('passes no servers when the workspace is not trusted, and never reads the config', async () => {
    const logger = { warn: vi.fn() }
    const cwd = workspaceWithConfig(
      JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.js'] } } })
    )
    try {
      expect(await resolveAcpLaunchMcpServers(cwd, logger, () => false)).toEqual([])
      expect(logger.warn).not.toHaveBeenCalled()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('maps enabled stdio and http servers of the workspace config', async () => {
    const cwd = workspaceWithConfig(
      JSON.stringify({
        mcpServers: {
          local: { command: 'node', args: ['server.js'], env: { TOKEN: 't' } },
          remote: { type: 'http', url: 'https://mcp.example/mcp', headers: { 'X-A': 'b' } },
          legacy: { type: 'sse', url: 'https://mcp.example/sse' }
        }
      })
    )
    try {
      expect(await resolveAcpLaunchMcpServers(cwd)).toEqual([
        {
          name: 'local',
          command: 'node',
          args: ['server.js'],
          env: [{ name: 'TOKEN', value: 't' }]
        },
        {
          type: 'http',
          name: 'remote',
          url: 'https://mcp.example/mcp',
          headers: [{ name: 'X-A', value: 'b' }]
        },
        { type: 'sse', name: 'legacy', url: 'https://mcp.example/sse', headers: [] }
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('skips disabled, disabled-flagged and command-less entries but keeps the rest', async () => {
    const cwd = workspaceWithConfig(
      JSON.stringify({
        mcpServers: {
          off: { command: 'node', enabled: false },
          flagged: { command: 'node', disabled: true },
          broken: { env: { A: 'b' } },
          live: { command: 'node' }
        }
      })
    )
    try {
      expect(await resolveAcpLaunchMcpServers(cwd)).toEqual([
        { name: 'live', command: 'node', args: [], env: [] }
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('passes no servers for an unreadable config instead of failing the launch', async () => {
    const cwd = workspaceWithConfig('{not json')
    try {
      expect(await resolveAcpLaunchMcpServers(cwd)).toEqual([])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('filterAcpMcpServersByCapabilities', () => {
  const servers = [
    { name: 'local', command: 'node', args: [], env: [] },
    { type: 'http', name: 'remote', url: 'https://mcp.example/mcp', headers: [] },
    { type: 'sse', name: 'legacy', url: 'https://mcp.example/sse', headers: [] }
  ] as const

  it('keeps every server for an agent advertising both remote transports', () => {
    expect(filterAcpMcpServersByCapabilities(servers, { http: true, sse: true })).toEqual(servers)
  })

  it('drops only the remote transports the agent never advertised', () => {
    expect(filterAcpMcpServersByCapabilities(servers, { http: true, sse: false })).toEqual([
      servers[0],
      servers[1]
    ])
    expect(filterAcpMcpServersByCapabilities(servers, { http: false, sse: false })).toEqual([
      servers[0]
    ])
  })

  it('names the dropped count in a warning', () => {
    const logger = { warn: vi.fn() }
    filterAcpMcpServersByCapabilities(servers, { http: false, sse: false }, logger)
    expect(logger.warn).toHaveBeenCalledWith(
      'Agent does not advertise the transport of some workspace MCP servers; dropped',
      { scope: 'acp-launch-mcp', dropped: 2 }
    )
  })
})
