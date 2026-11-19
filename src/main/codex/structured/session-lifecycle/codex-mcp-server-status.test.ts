import { expect, it } from 'vitest'
import type { CodexMcpRequest } from './codex-mcp-server-status'
import { listCodexMcpServers } from './codex-mcp-server-status'

function request(replies: Record<string, unknown>): CodexMcpRequest {
  return async (method) => replies[method]
}

const projectConfig = {
  config: {
    mcp_servers: {
      docs: { command: 'docs' },
      search: { enabled: false }
    }
  },
  layers: [
    {
      name: { type: 'user' },
      config: { mcp_servers: { docs: { command: 'docs' } } }
    }
  ]
}

it('lists configured MCP servers when the runtime inventory is empty', async () => {
  const servers = await listCodexMcpServers(
    request({
      'config/read': projectConfig,
      'mcpServerStatus/list': { data: [] }
    }),
    { threadId: null, cwd: '/repo' }
  )
  expect(servers.map((server) => [server.name, server.status, server.canToggle])).toEqual([
    ['docs', 'pending', true],
    ['search', 'disabled', false]
  ])
})

it('keeps a runtime row and adds only the configured servers the inventory omitted', async () => {
  const servers = await listCodexMcpServers(
    request({
      'config/read': projectConfig,
      'mcpServerStatus/list': {
        data: [
          { name: 'docs', runtimeStatus: 'connected', tools: { read: {} } },
          {
            name: 'plugin-server',
            runtimeStatus: 'failed',
            pluginId: 'plugin',
            toolsError: 'error: boom'
          }
        ]
      }
    }),
    { threadId: 'thread-1', cwd: '/repo' }
  )
  expect(servers.map((server) => [server.name, server.status, server.source])).toEqual([
    ['docs', 'connected', null],
    ['plugin-server', 'failed', 'plugin'],
    ['search', 'disabled', null]
  ])
  expect(servers[0]?.toolCount).toBe(1)
  expect(servers[1]?.canReconnect).toBe(true)
})
