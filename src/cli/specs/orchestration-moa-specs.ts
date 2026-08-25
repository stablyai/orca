import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_MOA_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'moa-log'],
    summary: 'Append entries to a MoA deliberation ledger',
    usage:
      'orca orchestration moa-log --deliberation <id> (--kind <kind> [--round <n>] [--seat <label>] [--target <entry_id>] [--verdict <verdict>] [--rationale <text>] [--payload <json>] [--authored-at <iso>] | --entries-file <path>) [--task <task_id>] [--seat-count <n>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'deliberation',
      'kind',
      'round',
      'seat',
      'target',
      'verdict',
      'rationale',
      'payload',
      'authored-at',
      'entries-file',
      'task',
      'seat-count',
      'run',
      'from',
      'retry-request'
    ],
    notes: [
      'Entries are append-only and content-addressed: resending the same entry is an ignored duplicate, never a second row.',
      'Kinds: proposal, verdict, outcome, close, note. Verdicts: support, challenge, merge, adopted, rejected.',
      'Prefer --entries-file for batches; it avoids shell-quoted JSON, which PowerShell mangles.'
    ]
  },
  {
    path: ['orchestration', 'moa-show'],
    summary: 'Show MoA deliberations or one ledger',
    usage:
      'orca orchestration moa-show [--deliberation <id>] [--round <n>] [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'deliberation', 'round', 'run', 'from'],
    notes: [
      '--run inspects a named Run without binding; otherwise deliberations are scoped to the caller.',
      'Entries are ordered (round, authored_at, id) — author order, not arrival order.'
    ]
  }
]
