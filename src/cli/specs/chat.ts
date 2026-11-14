import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'

export const CHAT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['chat', 'usage'],
    summary: 'Read a held chat’s cumulative primary-thread tokens',
    usage: 'orca chat usage [--session <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session'],
    notes: [
      'Defaults to the current local chat. With --environment, an explicit target-host session id is required.',
      'Reads the held provider connection without starting a chat or sending input. Active, changed or unsupported meters return unknown.',
      'Primary-thread counters exclude auxiliary requests and do not prove billing or route qualification. Account identifiers are hashed.'
    ],
    examples: ['orca chat usage --session <sessionId> --json']
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
