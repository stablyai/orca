import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_RUN_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'run-create'],
    summary: 'Create and bind a lightweight orchestration Run',
    usage:
      'orca orchestration run-create --objective <text> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'objective', 'from', 'retry-request'],
    notes: [
      'A Run is a namespace and home inbox. It never schedules or places workers.',
      '--retry-request is only for exact recovery after an unknown mutation result.'
    ]
  },
  {
    path: ['orchestration', 'run-use'],
    summary: 'Bind this coordinator terminal to an existing Run',
    usage:
      'orca orchestration run-use --id <run_id> [--from <handle>] [--takeover-legacy] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'from', 'takeover-legacy', 'retry-request'],
    notes: [
      '--takeover-legacy must run in the live coordinator agent terminal it binds; it preserves existing worker assignments.'
    ]
  },
  {
    path: ['orchestration', 'run-current'],
    summary: 'Show the Run bound to this coordinator terminal',
    usage: 'orca orchestration run-current [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'from']
  },
  {
    path: ['orchestration', 'run-list'],
    summary: 'List lightweight orchestration Runs',
    usage: 'orca orchestration run-list [--limit <n>] [--cursor <cursor>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'cursor']
  },
  {
    path: ['orchestration', 'run-show'],
    summary: 'Show one lightweight orchestration Run',
    usage: 'orca orchestration run-show --id <run_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id']
  },
  {
    path: ['orchestration', 'run-settle'],
    summary: "Clean a Run's owned child worktrees",
    usage:
      'orca orchestration run-settle --id <run_id> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'from', 'retry-request'],
    notes: [
      'Only host-qualified created-child worktrees owned by this Run are eligible; retained or unverifiable resources remain pending with recovery actions.'
    ]
  },
  {
    path: ['orchestration', 'run-complete'],
    summary: 'Explicitly complete a Run with summary and evidence',
    usage:
      'orca orchestration run-complete --id <run_id> --summary <text> --evidence <text> [--evidence <text>] [--waive-task <task_id>=<reason>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'id',
      'summary',
      'evidence',
      'waive-task',
      'from',
      'retry-request'
    ],
    notes: [
      'Only the current coordinator generation may complete the Run.',
      'Required deliverable Tasks must be completed or explicitly waived with a recorded reason. Operational Tasks and unverifiable resources remain visible as separate reliability warnings.',
      'Completion does not stop or settle resources; use run-settle separately for owned child-worktree cleanup.'
    ]
  }
]
