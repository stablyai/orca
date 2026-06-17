import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const MATRIX_MCP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['matrix-mcp'],
    summary: 'Run the Orca Matrix MCP stdio server (spawned by agents in a session)',
    usage: 'orca matrix-mcp',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Internal: Orca injects this as an MCP server at agent launch when the Matrix adapter is enabled. It self-scopes via inherited env (ORCA_PANE_KEY / ORCA_AGENT_HOOK_PORT / ORCA_AGENT_HOOK_TOKEN) and relays agent messages to the operator’s Matrix room over the agent-hooks loopback server.'
    ],
    examples: ['orca matrix-mcp']
  }
]
