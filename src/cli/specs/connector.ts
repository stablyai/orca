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
  },
  {
    path: ['connector', 'prompt'],
    hidden: true,
    summary: "Show what a dev connector conversation's agent is waiting on",
    usage: 'orca connector prompt --conversation <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'conversation'],
    notes: [
      CONNECTOR_NOTES[0],
      'An approval or a one-question single choice can be answered here; anything else reads unsupported, to answer in Orca.'
    ]
  },
  {
    path: ['connector', 'answer'],
    hidden: true,
    summary: "Answer a dev connector conversation's pending prompt",
    usage: 'orca connector answer --conversation <id> --prompt-id <id> --option <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'conversation', 'prompt-id', 'option'],
    notes: [
      CONNECTOR_NOTES[0],
      'Refused unless --prompt-id is the prompt still pending in the same agent process, so a late answer never types into whatever came next.'
    ]
  },
  {
    path: ['connector', 'cancel'],
    hidden: true,
    summary: 'Cancel what a dev connector conversation is doing',
    usage: 'orca connector cancel --conversation <id> --delivery-id <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'conversation', 'delivery-id'],
    notes: [
      ...CONNECTOR_NOTES,
      'Drops follow-ups not yet sent, rejects a pending approval, or interrupts a working agent with one Escape. An idle agent is left alone.'
    ]
  },
  {
    path: ['connector', 'watch'],
    hidden: true,
    summary: 'Collect connector conversation events for a while',
    usage: 'orca connector watch [--for-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'for-ms'],
    notes: [
      CONNECTOR_NOTES[0],
      'Prints a snapshot of every linked conversation, then each event (linked, prompt, turn-started, turn-ended) seen in the window; --for-ms defaults to 30000.'
    ]
  }
]
