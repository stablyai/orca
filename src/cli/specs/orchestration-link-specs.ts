import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const ORCHESTRATION_LINK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'link-show'],
    summary: 'Read your human-created session link and its journal',
    usage: 'orca orchestration link-show --id <link_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    notes: [
      'Links are created only by the owner in Orca. This command does not wake another agent.'
    ]
  },
  {
    path: ['orchestration', 'link-send'],
    summary: 'Send a message to a linked participant',
    usage:
      'orca orchestration link-send --id <link_id> --body <text> [--kind <kind>] [--to <session_id>] [--reply-to <message_id>] [--operation <id>] [--choices-json <json>] [--allow-other <true|false>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'id',
      'body',
      'kind',
      'reply-to',
      'to',
      'operation',
      'choices-json',
      'allow-other'
    ],
    notes: [
      'In a group, choose the recipient with --to <session_id>. Replies route to the original sender. Owner requests need no peer recipient.',
      'Kinds: message, question, checkpoint, reply, owner-request. After a question/checkpoint, finish your turn and wait for an answer; do not poll.',
      'For owner-request, --choices-json accepts 2–4 objects with label (up to 80 characters) and optional description (up to 200). Free text is allowed by default; --allow-other false requires choices. Older hosts receive the choices as text.',
      'Read the delivery receipt: queued or sending is not delivered. An owner-request is recorded for the owner and pauses the link.',
      'Retry an uncertain send with the same --operation and exact content. It never grants spending or other owner permissions.'
    ]
  },
  {
    path: ['orchestration', 'link-control'],
    summary: 'Stop or leave your existing session link',
    usage:
      'orca orchestration link-control --id <link_id> --action <stop|end> --turn-operation <delivery_operation> [--operation <id>] [--summary <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'summary', 'id', 'action', 'turn-operation', 'operation'],
    notes: [
      'Only the owner can create or resume a link. Stop pauses it and cancels only turns started by this link. End keeps the journal; the reviewer should include --summary with the acceptance decision. Copy --turn-operation from the originating link message; an older background command cannot exempt a later turn.'
    ]
  }
]
