import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const CONVERSATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['conversation', 'read'],
    summary: 'Read a referenced conversation from any supported agent',
    usage:
      'orca conversation read <reference-uri> [--from <message-index>] [--cursor <cursor>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'reference', 'from', 'cursor', 'limit'],
    positionalArgs: ['reference'],
    notes: [
      'Reads the original conversation without starting its agent. Continue with the returned nextCursor. A changed source requires a fresh read.'
    ]
  },
  {
    path: ['conversation', 'search'],
    summary: 'Find text inside one referenced conversation',
    usage:
      'orca conversation search <reference-uri> --query <words> [--cursor <cursor>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'reference', 'query', 'cursor', 'limit'],
    positionalArgs: ['reference'],
    notes: [
      'Literal case-insensitive search of this conversation only. Does not require the global search index.'
    ]
  }
]
