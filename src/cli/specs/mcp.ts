import type { CommandSpec } from '../discovery/command-spec'
import { LOCAL_COMMAND_FLAGS } from '../arguments/args'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

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
  },
  {
    path: ['mcp'],
    summary: 'Serve Orca worktrees, agents and terminals to an MCP client over stdio',
    usage: 'orca mcp [--environment <selector>]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Speaks the Model Context Protocol (JSON-RPC over stdin/stdout) for clients such as Claude Code or Codex. Register it as a stdio server whose command is `orca mcp`; it is not meant to be run by hand.',
      'Tools: orca_status, worktree_list, worktree_ps, worktree_create, agent_launch, terminal_list, terminal_read, terminal_send, terminal_wait, orchestration_run_list, orchestration_task_list. Each tool runs the matching `orca ... --json` command and returns its JSON, so results and errors match the CLI.',
      'Nothing destructive is exposed: no worktree removal, terminal stop or close.',
      'Agent launches return at once and the agent keeps running; poll with worktree_ps or terminal_read, and continue an idle agent with terminal_send instead of launching another.',
      '--environment (or ORCA_ENVIRONMENT) applies to every tool call, so one server can drive a paired remote Orca. Stdout carries only protocol messages; diagnostics go to stderr.'
    ],
    examples: [
      'claude mcp add orca -- orca mcp',
      'codex mcp add orca -- orca mcp',
      'orca mcp --environment sandbox'
    ]
  }
]
