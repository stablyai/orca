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
    // Control-key input uses the raw path; text-plus-Enter may use agent prompt delivery.
    "Without --enter, --text writes raw bytes to the PTY without bracketed-paste wrapping. In Bash/Zsh, ANSI-C quoted control bytes such as Escape ($'\\x1b') or Ctrl+U ($'\\x15') are passed through.",
    '--interrupt is a convenience that appends Ctrl+C (\\x03). Prefer --text when you need other control sequences.',
    'With --text and --enter (without --interrupt), agent prompts may use bracketed paste and tracked submission.',
    'For a text-plus-Enter agent prompt, the result separates input acceptance from observed submission and turn start.',
    '--wait-submit only observes the accepted prompt for the requested duration; timeout returns the queued/input-accepted receipt and never resends.',
    'After an ambiguous transport failure, reissue the exact command with the reported --retry-request ID. The ID is bound to the prompt payload and exact terminal process incarnation.',
    'Older hosts accept the legacy raw input but report provider old-host and do not offer idempotent retry or submission observation.'
  ],
  examples: [
    'orca terminal send --terminal term_123 --text "hi" --enter',
    "orca terminal send --terminal term_123 --text $'\\x1b' # Bash/Zsh ANSI-C quoting",
    'orca terminal send --terminal term_123 --interrupt'
  ]
}
