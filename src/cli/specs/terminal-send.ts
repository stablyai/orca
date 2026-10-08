import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_SEND_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'send'],
  summary: 'Send input to a live terminal',
  usage:
    'orca terminal send [--terminal <handle>] [--text <text> | --text-stdin] [--enter] [--interrupt] [--wait-submit <seconds>] [--retry-request <id>] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'terminal',
    'text',
    'text-stdin',
    'enter',
    'interrupt',
    'wait-submit',
    'retry-request'
  ],
  notes: [
    'Use --text-stdin for UTF-8 text from a pipe; it waits for EOF and refuses interactive TTY input. Do not combine it with --text.',
    'Stdin preserves whitespace and newlines; --enter is a separate submit action. Empty stdin is legal, but cannot be used with --wait-submit or --retry-request.',
    'Terminal stdin accumulation is limited to 16 MiB; the existing local RPC limit is 1 MiB including JSON framing and escaping, so large input may still fail delivery.',
    'For a text-plus-Enter agent prompt, the result separates input acceptance from observed submission and turn start.',
    '--wait-submit only observes the accepted prompt for the requested duration; timeout returns the queued/input-accepted receipt and never resends.',
    'After an ambiguous transport failure, reissue the exact command with the reported --retry-request ID. The ID is bound to the prompt payload and exact terminal process incarnation.',
    'Older hosts accept the legacy raw input but report provider old-host and do not offer idempotent retry or submission observation.'
  ]
}
