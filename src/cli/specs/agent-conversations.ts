import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

export const AGENT_CONVERSATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'list'],
    summary: 'List agents, chats and terminals, with their Orca session IDs',
    usage: 'orca agent list [--worktree <selector>] [--state <state>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'state'],
    notes: [
      "Lists agents in this Orca host's workspaces: chats and terminal agents alike, each with its `orca_session_id:` ID. A terminal agent shows no ID until it first reports to Orca.",
      'A chat keeps its ID across /clear; a terminal agent gets a new one when /clear starts a new conversation.',
      '--state keeps agents in one state: working, blocked, waiting or done.',
      'To see which agent CLIs are installed and can be launched, use `orca agent installed`.',
      'Agents on other hosts are not listed here; the output names those hosts and the `--environment` that lists them.',
      'A finished terminal agent stays listed as done while asleep, even after Orca restarts, unless it was reopened and slept again before doing anything new. An agent put to sleep mid-turn is not listed. After reopening, a terminal agent reappears only once it reports to Orca (for Codex, on its next turn). `orca agent read <id>` still reads it, except a sleeping WSL agent on Windows.'
    ],
    examples: ['orca agent list --json', 'orca agent list --worktree active --state working']
  },
  {
    path: ['agent', 'show'],
    summary: 'Show where an agent is, by its Orca session ID',
    usage: 'orca agent show <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [
      '<id> is the `orca_session_id:` ID from `orca agent list` or Copy Orca Session ID.',
      'An agent resumed in two panes shows both; one that is closed shows none. A listed sleeping terminal agent shows its last state and where it wakes when its workspace is reopened.'
    ],
    examples: ['orca agent show orca_session_id:3540ecf3-47c3-4876-b825-81bf5d6b3595 --json']
  },
  {
    path: ['agent', 'focus'],
    summary: 'Focus an agent in the UI, by its Orca session ID',
    usage: 'orca agent focus <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [
      '<id> is the `orca_session_id:` ID from `orca agent list` or Copy Orca Session ID.',
      'Activates the workspace and focuses the pane `orca agent show` reports first, like `orca terminal switch`; agents should run it only when the user asked to switch.',
      'An agent that is not open in any workspace is refused.',
      "With --environment, the desktop app on this machine switches to that server's agent; a server has no window of its own."
    ],
    examples: ['orca agent focus orca_session_id:3540ecf3-47c3-4876-b825-81bf5d6b3595']
  },
  {
    path: ['agent', 'read'],
    summary: 'Read what an agent said, by its Orca session ID',
    usage: 'orca agent read <id> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'limit'],
    positionalArgs: ['id'],
    notes: [
      "Reads the conversation, not a terminal screen: a chat's history, or a terminal agent's own transcript. The agent need not be running, and reading never starts it.",
      '--limit is the number of newest entries (default 20, at most 100).',
      'The output can start with a state for the latest turn this history records: `working` means it shows an unfinished turn, so its reply may not be there yet. A terminal agent that exited mid-turn may keep reading `working`; check `orca agent show`. No state means unknown, never done. `orca agent list` and `show` report the last state known to Orca, which may differ.',
      'A terminal agent can be read while Orca knows where its transcript is: while it is open, or asleep in a workspace. On Windows, a sleeping agent that ran in WSL can be read once its tab is reopened.'
    ],
    examples: [
      'orca agent read orca_session_id:3540ecf3-47c3-4876-b825-81bf5d6b3595 --limit 10',
      'orca agent read orca_session_id:3540ecf3-47c3-4876-b825-81bf5d6b3595 --json'
    ]
  }
]
