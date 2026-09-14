import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const MULTIPLEXER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['multiplexer', 'list'],
    summary: 'List workspace tab slots in the active multiplexer',
    usage: 'orca multiplexer list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['multiplexer', 'remove'],
    summary: 'Remove one workspace tab from the active multiplexer without stopping terminals',
    usage: 'orca multiplexer remove --slot <slot-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'slot'],
    notes: [
      'Get the exact slot id from multiplexer list. Does not delete worktrees, stop terminals, close the multiplexer, or alter other saved layouts. Repeated removal is a no-op.'
    ]
  }
]
