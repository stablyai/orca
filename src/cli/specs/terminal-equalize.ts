import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_EQUALIZE_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'equalize'],
  summary: 'Equalize pane sizes in a terminal tab',
  usage: 'orca terminal equalize [--terminal <handle>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
  examples: ['orca terminal equalize', 'orca terminal equalize --terminal term_abc123 --json']
}
