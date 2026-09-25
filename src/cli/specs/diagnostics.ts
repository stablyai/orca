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
    path: ['diagnostics', 'disk'],
    summary: 'Show on-disk size of private Codex sessions and terminal history',
    usage: 'orca diagnostics disk [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      "Reads this machine's Orca data directory. It does not start the app and it does not delete anything.",
      'Private Codex sessions default to 30 days and a 2 GB cap. Terminal history for a worktree that is gone uses the same limits.'
    ],
    examples: ['orca diagnostics disk', 'orca diagnostics disk --json']
  },
  {
    path: ['diagnostics', 'clear-history-older-than'],
    summary: 'Delete private Codex rollouts and gone-worktree terminal history older than a cutoff',
    usage: 'orca diagnostics clear-history-older-than [--days <n>] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'days', 'dry-run'],
    destructive: true,
    notes: [
      'Defaults to 30 days. Recent files are kept.',
      'Codex rollouts live under the private CODEX_HOME Orca creates. Your ~/.codex directory is not touched.',
      'Terminal-history directories are removed only when their worktree is no longer in any Orca profile. If a profile cannot be read, those directories are left in place.',
      '--dry-run prints the same counts without deleting.'
    ],
    examples: [
      'orca diagnostics clear-history-older-than --days 30 --dry-run',
      'orca diagnostics clear-history-older-than --days 30'
    ]
  }
]
