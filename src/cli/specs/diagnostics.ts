import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

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
  },
  {
    path: ['diagnostics', 'bundle'],
    summary: 'Export a local diagnostics ZIP with crash, memory, and system context',
    usage:
      'orca diagnostics bundle [--output <filename-or-subpath>] [--lookback <duration>] [--include <category>] [--exclude <category>] [--open] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'output', 'lookback', 'include', 'exclude', 'open'],
    notes: [
      'Creates a local ZIP under Orca logs/diagnostics by default. Native minidumps are included only in this explicit local export when present.',
      'Use repeated --include or --exclude flags to select categories. --lookback accepts minutes or m/h/d suffixes.'
    ],
    examples: [
      'orca diagnostics bundle --json',
      'orca diagnostics bundle --output orca-diagnostics.zip --lookback 2h',
      'orca diagnostics bundle --exclude native-minidumps'
    ]
  }
]
