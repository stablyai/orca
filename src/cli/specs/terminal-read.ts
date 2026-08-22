import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_READ_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'read'],
  summary: 'Read bounded terminal output',
  usage:
    'orca terminal read [--terminal <handle>] [--expected-incarnation-id <id>] [--cursor <n>] [--limit <n>] [--screen] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'terminal',
    'expected-incarnation-id',
    'cursor',
    'limit',
    'screen'
  ],
  notes: [
    'Omit --terminal to target the active terminal in the current worktree.',
    'By default this returns accumulated terminal output with escape sequences stripped, not the rendered screen. Any program that repaints a line — shells, progress bars, TUIs — comes back as stacked fragments, so one `clear` keystroke by keystroke reads as `cclclecleaclear`, and spaces a prompt draws by moving the cursor are absent.',
    'Use --screen to read what the terminal actually renders. Prefer it whenever the answer depends on how output looks rather than what was emitted over time; the default is unsuitable for verifying rendered output.',
    'The result reports source: stream when it is accumulated output, screen when it is the rendered screen, and screen-unavailable when a screen was asked for but none could be rendered and the accumulated output is being returned instead. An absent source means the host predates the field.',
    '--screen and --cursor are mutually exclusive: a screen read is the current frame and has no history to page.',
    'Use --cursor with the nextCursor value from a previous read to get only new output since that read.',
    'Use --expected-incarnation-id with terminal list/show identity when output must belong to that exact process.',
    'Use --limit to request more retained lines for long agent responses; output reports oldestCursor when older lines were dropped.',
    'Useful for capturing the response to a command: read before sending, then read --cursor <prev> after waiting.'
  ],
  examples: [
    'orca terminal read --json',
    'orca terminal read --terminal term_abc123 --cursor 42 --limit 1000 --json',
    'orca terminal read --terminal term_abc123 --screen --json'
  ]
}
