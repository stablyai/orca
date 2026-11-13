import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'

export const AGENT_CONVERSATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'list'],
    summary: 'List open agents, chats and terminals, with their Orca session IDs',
    usage: 'orca agent list [--worktree <selector>] [--state <state>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'state'],
    notes: [
      "Lists the agents open in this Orca host's workspaces: chats and terminal agents alike, each with its `orca_session_id:` ID. A terminal agent shows no ID until it first reports to Orca.",
      'A chat keeps its ID across /clear; a terminal agent gets a new one when /clear starts a new conversation.',
      '--state keeps agents in one state: working, blocked, waiting or done.',
      'Agents on other hosts are not listed here; the output names those hosts and the `--environment` that lists them.'
    ],
    examples: ['orca agent list --json', 'orca agent list --worktree active --state working']
  },
  {
    path: ['agent', 'show'],
    summary: 'Show where an agent is open, by its Orca session ID',
    usage: 'orca agent show <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [
      '<id> is the `orca_session_id:` ID from `orca agent list` or Copy Orca Session ID.',
      'An agent resumed in two panes shows both; one that is not open shows none.'
    ],
    examples: ['orca agent show orca_session_id:claude_1234 --json']
  },
  {
    path: ['agent', 'read'],
    summary: 'Read what an agent said, by its Orca session ID',
    usage: 'orca agent read <id> [--limit <n>] [--cursor <cursor>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'limit', 'cursor'],
    positionalArgs: ['id'],
    notes: [
      "Reads the conversation, not a terminal screen: a chat's history, or a terminal agent's own transcript. The agent need not be running, and reading never starts it.",
      '--limit is the number of entries (default 20, at most 100). Pass the printed --cursor to read only what came after.',
      'A terminal agent can be read while Orca knows where its transcript is: while it is open, or asleep in a workspace.'
    ],
    examples: [
      'orca agent read orca_session_id:claude_1234 --limit 10',
      'orca agent read orca_session_id:codex_1234 --cursor <cursor> --json'
    ]
  }
]
