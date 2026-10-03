import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_CLOSE_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'close'],
  destructive: true,
  summary: 'Close one terminal, its whole tab, or every terminal in a workspace',
  usage:
    'orca terminal close ([--terminal <handle>] [--tab] | --worktree <selector> --all) [--host <host-id>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'tab', 'worktree', 'all', 'host'],
  notes: [
    'Without --all, closes one terminal pane/session; add --tab to close its whole tab.',
    'With --worktree <selector> --all, stops every terminal process owned by that workspace and durably removes its terminal tabs, layouts, and resume records.',
    'Use workspace Sleep when the terminals and agent sessions should resume later.',
    '--host runtime:<environment-id> targets that paired Orca server; use the id from `orca environment list`, not the environment name.'
  ],
  examples: [
    'orca terminal close --terminal term_abc123',
    'orca terminal close --terminal term_abc123 --tab --json',
    'orca terminal close --worktree active --all --json',
    'orca terminal close --terminal term_abc123 --host runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3 --json'
  ]
}
