import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { readRecord } from '../../app-server/codex-item-field-readers'

type Connection = Pick<CodexAppServerConnection, 'request'>

export const CODEX_EXECUTION_MEMORY_CONFIG = {
  'features.memories': false,
  'features.memory_tool': false,
  'memories.generate_memories': false,
  'memories.use_memories': false
} as const

export function assertCodexExecutionMemoryDisabled(config: unknown): void {
  const features = readRecord(readRecord(config).features)
  const memories = readRecord(readRecord(config).memories)
  if (
    features.memories !== false ||
    features.memory_tool !== false ||
    memories.generate_memories !== false ||
    memories.use_memories !== false
  ) {
    throw new Error('Bounded Codex memory isolation unavailable.')
  }
}

export async function codexExecutionThreadConfig(connection: Connection, cwd: string) {
  const response = readRecord(
    await connection.request('config/read', { cwd, includeLayers: true }, { timeoutMs: 2_000 })
  )
  if (!response.config || !Array.isArray(response.layers)) {
    throw new Error('Bounded Codex tool configuration unavailable.')
  }
  assertCodexExecutionMemoryDisabled(response.config)
  const servers = new Set<string>()
  const configs = [response.config, ...response.layers.map((layer) => readRecord(layer).config)]
  for (const config of configs) {
    for (const name of Object.keys(readRecord(readRecord(config).mcp_servers))) {
      if (name.length > 512 || servers.size >= 128) {
        throw new Error('Bounded Codex tool configuration exceeds its limit.')
      }
      servers.add(name)
    }
  }
  return {
    ...CODEX_EXECUTION_MEMORY_CONFIG,
    mcp_servers: Object.fromEntries(
      [...servers].map((name) => [name, { enabled: false, required: false }])
    )
  }
}

export async function assertCodexExecutionToolsDisabled(connection: Connection, threadId: string) {
  const response = readRecord(
    await connection.request('mcpServerStatus/list', { threadId, limit: 100 }, { timeoutMs: 2_000 })
  )
  if (
    !Array.isArray(response.data) ||
    response.data.length > 128 ||
    response.nextCursor ||
    response.data.some((value) => {
      const server = readRecord(value)
      return (
        server.runtimeStatus !== 'disabled' ||
        !server.tools ||
        Object.keys(readRecord(server.tools)).length > 0 ||
        !Array.isArray(server.resources) ||
        server.resources.length > 0 ||
        !Array.isArray(server.resourceTemplates) ||
        server.resourceTemplates.length > 0
      )
    })
  ) {
    throw new Error('Bounded Codex tools are not isolated.')
  }
}
