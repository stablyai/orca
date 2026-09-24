import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_SET_PANE_TITLE_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'set-pane-title'],
  summary: 'Set or clear the title of one terminal pane',
  usage: 'orca terminal set-pane-title [--terminal <handle>] [--title <text>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'title'],
  notes: [
    'Sets the title of ONE pane. Split panes share a tab, so terminal rename cannot address one of them; use this command for a single pane.',
    'Pass --title "" to clear the pane back to its automatic title.'
  ],
  examples: [
    'orca terminal set-pane-title --terminal term_abc123 --title "RUNNER"',
    'orca terminal set-pane-title --terminal term_abc123 --title "" --json'
  ]
}
