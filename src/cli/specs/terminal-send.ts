import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_SEND_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'send'],
  summary: 'Send input to a live terminal',
  usage:
    'orca terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt] [--wait-submit <seconds>] [--retry-request <id>] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'terminal',
    'text',
    'enter',
    'interrupt',
    'wait-submit',
    'retry-request'
  ],
  notes: [
    'For a text-plus-Enter agent prompt, the result separates input acceptance from observed submission and turn start.',
    '--wait-submit only observes the accepted prompt for the requested duration; timeout returns the queued/input-accepted receipt and never resends.',
    'After an ambiguous transport failure, reissue the exact command with the reported --retry-request ID. The ID is bound to the prompt payload and exact terminal process incarnation.',
    'Older hosts accept the legacy raw input but report provider old-host and do not offer idempotent retry or submission observation.'
  ]
}
