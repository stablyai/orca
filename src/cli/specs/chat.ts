import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'

export const CHAT_COMMAND_SPECS: CommandSpec[] = [
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
  },
  {
    path: ['chat', 'send'],
    summary: 'Send a message to a chat, as if typed in its tab',
    usage: 'orca chat send --session <id> (--text <text> | --text-file <path|->) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'text', 'text-file'],
    notes: [
      '--session takes the chat session id `orca agent launch` prints, or the `structured-agent-session-<id>` pane key that `orca worktree ps` shows, without the prefix.',
      'The message continues the same chat in its existing tab: an idle chat starts its next turn, a chat in the middle of a turn queues the message until the turn ends, and a chat whose agent was stopped for idleness is started again with its history.',
      '--text-file - reads the message from stdin.'
    ],
    examples: [
      'orca chat send --session <sessionId> --text "Continue with the next step"',
      'echo "Read the ticket again" | orca chat send --session <sessionId> --text-file - --json'
    ]
  },
  {
    path: ['chat', 'close'],
    summary: 'Close a chat tab and stop its agent',
    usage: 'orca chat close --session <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session'],
    notes: [
      'The same as closing the tab by hand: the agent stops and the tab goes away. The conversation stays in Session History.'
    ],
    examples: ['orca chat close --session <sessionId> --json']
  }
]
