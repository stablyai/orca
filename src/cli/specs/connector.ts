import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const CONNECTOR_NOTES = [
  'Development only: drives the connector seam as a `dev` conversation, without Slack. The host refuses it unless its experimentalConnectors setting is on.',
  'A retry with the same --delivery-id and payload returns the first answer instead of delivering again.'
]

export const CONNECTOR_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['connector', 'start'],
    hidden: true,
    summary: 'Start a dev connector conversation with a background terminal agent',
    usage:
      'orca connector start --conversation <id> --delivery-id <id> --agent claude|codex --prompt <text> (--worktree <selector> | --project-group <id> [--name <name>]) [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'conversation',
      'delivery-id',
      'agent',
      'prompt',
      'worktree',
      'project-group',
      'name'
    ],
    notes: [
      ...CONNECTOR_NOTES,
      '--worktree starts in an existing workspace; --project-group creates a folder workspace in that folder project.'
    ]
  },
  {
    path: ['connector', 'send'],
    hidden: true,
    summary: 'Send a follow-up into a dev connector conversation',
    usage: 'orca connector send --conversation <id> --delivery-id <id> --text <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'conversation', 'delivery-id', 'text'],
    notes: [
      ...CONNECTOR_NOTES,
      'Held while the agent is asking for permission, and sent once it is answered.'
    ]
  }
]
