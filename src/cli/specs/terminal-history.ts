import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_HISTORY_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'history'],
  summary:
    'Retrieve the scrollback buffer of a terminal session as one string (stack traces, logs, command output)',
  usage: 'orca terminal history [--terminal <handle>] [--tail-lines <n>] [--screen] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'tail-lines', 'screen'],
  notes: [
    'Use this to read stack traces, logs, and command outputs for debugging instead of asking the user to copy them out of the terminal.',
    'Omit --terminal to target the active terminal in the current worktree; run terminal list to discover handles for the others.',
    '--tail-lines defaults to 200 and is capped by the host retention limit. result.truncated reports that older output is not included.',
    'Escape sequences are already stripped, but by default this is accumulated output rather than the rendered screen, so a repainted line arrives as stacked fragments. Pass --screen when the answer depends on how the terminal looks.',
    'Use terminal read instead when you need cursor pagination to follow a long-running command incrementally.'
  ],
  examples: [
    'orca terminal history --json',
    'orca terminal history --terminal term_abc123 --tail-lines 500 --json',
    'orca terminal history --terminal term_abc123 --screen --json'
  ]
}
