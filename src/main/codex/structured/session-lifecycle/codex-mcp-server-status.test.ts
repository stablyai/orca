import { expect, it } from 'vitest'
import type { CodexMcpRequest } from './codex-mcp-server-status'
import { listCodexMcpServers } from './codex-mcp-server-status'

function request(replies: Record<string, unknown>): CodexMcpRequest {
  return async (method) => replies[method]
}

// config/read with the chat's cwd, as Codex 0.167 answers for a trusted project.
const projectConfig = {
  config: {
    mcp_servers: {
      docs: { command: 'docs', enabled: true },
      search: { command: 'search', enabled: false },
      tracker: { command: 'tracker', enabled: true }
    }
  },
  layers: [
    { name: { type: 'project' }, config: { mcp_servers: { docs: {}, search: {} } } },
    { name: { type: 'user' }, config: { mcp_servers: { tracker: {} } } }
  ]
}

it('lists project servers that a threadless status read leaves out, without polling them', async () => {
  const servers = await listCodexMcpServers(
    request({
      'config/read': projectConfig,
      // Without a thread Codex reports only the user config's servers.
      'mcpServerStatus/list': {
        data: [{ name: 'tracker', runtimeStatus: null, tools: { read: {} }, toolsError: null }],
        nextCursor: null
      }
    }),
    { threadId: null, cwd: '/repo' }
  )
  expect(servers.map((server) => [server.name, server.status, server.canToggle])).toEqual([
    ['tracker', 'connected', true],
    ['docs', 'not-started', false],
    ['search', 'disabled', false]
  ])
})
