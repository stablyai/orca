import type { McpServerTypedFailureCode } from '../../shared/mcp-servers/mcp-servers'

/** An mcpServers.* refusal; the RPC answer carries `code` so a client can tell them apart. */
export class McpServersError extends Error {
  constructor(
    readonly code: McpServerTypedFailureCode,
    message: string
  ) {
    super(message)
    this.name = 'McpServersError'
  }
}
