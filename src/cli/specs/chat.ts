import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

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
    summary: 'Close a chat tab',
    usage: 'orca chat close --session <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session'],
    notes: [
      '--session takes the chat session id `orca agent launch` prints, and is always required.',
      "Closing stops the chat's agent and removes its tab, the same as closing the tab by hand. The conversation stays in Session History."
    ],
    examples: ['orca chat close --session <sessionId> --json']
  }
]
