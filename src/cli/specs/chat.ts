import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

export const CHAT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['chat', 'list'],
    summary: 'List native chat sessions across workspaces',
    usage: 'orca chat list [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit'],
    notes: [
      'Lists structured chat sessions the host reports through worktree.ps, across every workspace. Terminal agents are not chats and do not appear.',
      'Each row carries the sessionId `orca chat read` and `orca chat rename` take, plus the paneKey, agent state, conversation name, and owning worktree.',
      'To write to a chat rather than read it, use `orca orchestration send --to orca_session_id:<sessionId>`; chat panes have no terminal handle.'
    ],
    examples: ['orca chat list --json', 'orca chat list --limit 50 --json']
  },
  {
    path: ['chat', 'read'],
    summary: 'Read a native chat transcript',
    usage:
      'orca chat read [--session <id>] [--limit <n>] [--direction tail|before|after] [--cursor <cursor>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'limit', 'direction', 'cursor'],
    notes: [
      'Reads the chat journal as transcript lines: user and assistant messages, tool calls with state and output heads, diffs, status rows, and turn lifecycle.',
      '--session takes the chat session id `orca agent launch` or `orca chat list` prints; a structured paneKey resolves too. Run inside a chat, it defaults to that chat; with --environment it is required.',
      "Default --direction tail returns the newest page. --direction before|after requires --cursor from an earlier read's window.nextCursor; after + a saved liveCursor polls incrementally. On a cursor reset the reply carries reset plus a bounded tail.",
      'Rows a subagent produced are prefixed [agentId]; [truncated] marks tool output the host shortened. Use `orca search` to locate a session by content, then read it here.'
    ],
    examples: [
      'orca chat read --session <sessionId> --limit 100 --json',
      'orca chat read --direction after --cursor <cursor> --json',
      'orca chat read --json'
    ]
  },
  {
    path: ['chat', 'rename'],
    summary: 'Rename a chat tab',
    usage: 'orca chat rename [--session <id>] --name <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'name'],
    notes: [
      '--session takes the chat session id `orca agent launch` prints. Run inside a chat, it defaults to that chat; with --environment it is required.',
      'The name shows in the tab, the sidebar, Session History and on paired phones, the same as renaming the tab by hand.'
    ],
    examples: [
      'orca chat rename --name "Migrate auth to OAuth"',
      'orca chat rename --session <sessionId> --name "Release notes" --json'
    ]
  }
]
