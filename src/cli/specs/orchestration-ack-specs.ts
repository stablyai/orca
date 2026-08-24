import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_ACK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'ack-verify'],
    summary: 'Query back cross-plane delivery and completion evidence',
    usage:
      'orca orchestration ack-verify --message-id <id> --correlation-id <id> --sender-epoch <epoch> --receiver-epoch <epoch> --orca-identity <id> --external-plane <plane> --external-identity <id> --link-evidence-id <id> [--ack-message-id <id>] [--completion-receipt-id <id>] [--dispatch-id <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'message-id',
      'ack-message-id',
      'completion-receipt-id',
      'correlation-id',
      'sender-epoch',
      'receiver-epoch',
      'dispatch-id',
      'orca-identity',
      'external-plane',
      'external-identity',
      'link-evidence-id'
    ],
    notes: [
      '`accepted` means storage only. `prompt_delivered` requires ACK read-back. `completion_verified` also requires native Dispatch query-back.',
      'Orca and external identities remain distinct; --link-evidence-id names the neutral coordinator evidence.'
    ]
  }
]
