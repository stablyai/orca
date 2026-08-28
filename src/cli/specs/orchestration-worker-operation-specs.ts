import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

/** The typed worker operations (B5) and the bounded recovery query (B10). Kept
 *  in their own module so the main orchestration spec list stays readable. */
export const ORCHESTRATION_WORKER_OPERATION_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'report'],
    summary: 'Report the terminal outcome of this Dispatch',
    usage:
      'orca orchestration report --task <task_id> --dispatch <dispatch_id> --outcome <succeeded|failed> --body <text> [--subject <text>] [--files-modified <csv>] [--report-path <path>] [--corrections <csv>] [--run <run_id>] [--outcome-id <id>] [--from <handle>] [--dispatch-capability <cap>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'dispatch',
      'dispatch-capability',
      'outcome',
      'subject',
      'body',
      'files-modified',
      'report-path',
      'corrections',
      'run',
      'outcome-id',
      'from',
      'retry-request'
    ],
    notes: [
      'The typed replacement for hand-built `send --type worker_done` command lines; the dispatch preamble emits it fully bound.',
      'The worker supplies only its typed outcome and concise report. Orca observes Git and reads the runtime-owned required-gate ledger itself; this command has no flag that can declare PASS.',
      'From a reviewer Dispatch, --corrections "<a>,<b>" routes one consolidated FIX_FIRST round back to the same retained builder; omit it to accept the commit.'
    ]
  },
  {
    path: ['orchestration', 'escalate'],
    summary: 'Raise a blocker on this Dispatch before completing',
    usage:
      'orca orchestration escalate --task <task_id> --dispatch <dispatch_id> --subject <text> [--body <text>] [--priority <level>] [--run <run_id>] [--from <handle>] [--dispatch-capability <cap>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'dispatch',
      'dispatch-capability',
      'subject',
      'body',
      'priority',
      'run',
      'from',
      'retry-request'
    ]
  },
  {
    path: ['orchestration', 'state'],
    summary: 'Show the exact bounded control-plane state for one target',
    usage:
      'orca orchestration state (--outcome <id> | --run <run_id> | --task <task_id> | --dispatch <dispatch_id>) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'outcome', 'run', 'task', 'dispatch'],
    notes: [
      'One call returns identity, lifecycle, last meaningful event, liveness, route certification, completion-gate status and the legal next actions.',
      'Use this for recovery instead of worker lists, transcript reads, or repeated status/show calls.'
    ]
  }
]
