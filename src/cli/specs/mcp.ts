import type { CommandSpec } from '../discovery/command-spec'
import { LOCAL_COMMAND_FLAGS } from '../arguments/args'

export const MCP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['mcp', 'connect'],
    summary: "Run one of this host's MCP servers over stdio for an agent's own MCP config",
    usage: 'orca mcp connect <id> --agent <agent> [--workspace <id> | --outside-workspace]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'id', 'agent', 'workspace', 'outside-workspace'],
    positionalArgs: ['id'],
    // Orca writes it into Grok's, Cursor's and Droid's MCP files; nobody types it.
    hidden: true
  },
  {
    path: ['mcp', 'exec'],
    summary: "Start one of this host's command MCP servers with its saved environment",
    usage: 'orca mcp exec <id> --agent <agent> [--workspace <id> | --outside-workspace]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'id', 'agent', 'workspace', 'outside-workspace'],
    positionalArgs: ['id'],
    // Orca writes it into an agent terminal's MCP config for a server with saved env; nobody types it.
    hidden: true
  },
  {
    path: ['mcp', 'env'],
    summary: "Print a command MCP server's saved environment for a WSL terminal's wrapper",
    usage: 'orca mcp env <id> --agent <agent> [--workspace <id> | --outside-workspace]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'id', 'agent', 'workspace', 'outside-workspace'],
    positionalArgs: ['id'],
    // Orca's WSL wrapper reads its NUL-separated output from a pipe; nobody types it.
    hidden: true
  }
]
