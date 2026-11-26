import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

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
    path: ['chat', 'close'],
    destructive: true,
    summary: 'Close a chat tab and stop its agent',
    usage: 'orca chat close --session <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session'],
    notes: [
      '--session takes the chat session id `orca agent launch` prints, or the `orcaSessionId` from `orca agent list`. It is always required, so a chat never closes itself by accident.',
      "The same as closing the tab by hand: the agent stops and the chat stays in Session History. A bot run keeps working in the bot's Activity."
    ],
    examples: [
      'orca chat close --session <sessionId>',
      'orca chat close --session orca_session_id:<sessionId> --json'
    ]
  }
]
