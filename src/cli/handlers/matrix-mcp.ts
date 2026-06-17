import type { CommandHandler } from '../dispatch'
import { runMatrixMcpServer } from '../matrix-mcp/stdio-server'

// `orca matrix-mcp` runs a long-lived stdio MCP server that the coding agent
// spawns inside an Orca session. It self-scopes via inherited env and talks to
// the agent-hooks loopback server, so it ignores ctx.client (no Orca runtime
// round-trip). The handler blocks until the stdio transport closes.
export const MATRIX_MCP_HANDLERS: Record<string, CommandHandler> = {
  'matrix-mcp': async () => {
    await runMatrixMcpServer()
  }
}
