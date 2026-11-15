import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'

export const DIAGNOSTICS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['diagnostics', 'memory'],
    summary: 'Collect a memory snapshot for Orca and managed terminals',
    usage: 'orca diagnostics memory [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Runs the same host process sweep used by the Resource Usage popover, so call it when you need a point-in-time diagnostic rather than a cheap heartbeat.'
    ],
    examples: ['orca diagnostics memory --json']
  }
]
