import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from './orchestration-worker-specs'
import {
  ORCHESTRATION_DISPATCH_DELIVERY_NOTE,
  ORCHESTRATION_MESSAGE_COMMAND_SPECS
} from './orchestration-message-specs'

export const ORCHESTRATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'run-create'],
    summary: 'Create and bind a lightweight orchestration Run',
    usage:
      'orca orchestration run-create --objective <text> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'objective', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'A Run is a namespace and home inbox. It never schedules or places workers.',
      '--retry-request is only for exact recovery after an unknown mutation result.'
    ]
  },
  {
    path: ['orchestration', 'run-use'],
    summary: 'Bind this coordinator to an existing Run',
    usage:
      'orca orchestration run-use --id <run_id> [--from <handle>] [--takeover-legacy] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'from', 'takeover-legacy', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      '--takeover-legacy must run in the live coordinator agent terminal it binds; it preserves existing worker assignments.'
    ]
  },
  {
    path: ['orchestration', 'run-current'],
    summary: 'Show the Run bound to this coordinator',
    usage: 'orca orchestration run-current [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'from'],
    identityFlagRoles: { from: 'caller' }
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
  ...ORCHESTRATION_MESSAGE_COMMAND_SPECS,
  {
    path: ['orchestration', 'task-create'],
    summary: 'Create an orchestration task',
    usage:
      'orca orchestration task-create --spec <text> [--task-title <text>] [--display-name <text>] [--deps <json_array>] [--parent <task_id>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'spec',
      'task-title',
      'display-name',
      'deps',
      'parent',
      'run',
      'from',
      'retry-request'
    ],
    identityFlagRoles: { from: 'caller' }
  },
  {
    path: ['orchestration', 'task-list'],
    summary: 'List orchestration tasks',
    usage:
      'orca orchestration task-list [--status <status>] [--ready] [--brief] [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'status', 'ready', 'brief', 'run', 'from'],
    identityFlagRoles: { from: 'caller' },
    notes: ['--brief collapses whitespace and caps each spec at 160 characters.']
  },
  {
    path: ['orchestration', 'task-update'],
    summary: 'Update a task status',
    usage:
      'orca orchestration task-update --id <task_id> --status <status> [--result <text>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'status', 'result', 'run', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Valid --status values: pending, ready, dispatched, completed, failed, blocked.',
      'To cancel a Task, stop or abandon its worker, then set --status failed --result cancelled; a later worker-start --retry-of reopens it.'
    ]
  },
  ...ORCHESTRATION_WORKER_COMMAND_SPECS,
  {
    path: ['orchestration', 'dispatch'],
    summary: 'Dispatch a task to a terminal',
    usage:
      'orca orchestration dispatch --task <task_id> --to <handle> [--from <handle>] [--run <run_id>] [--inject] [--delivery <queue|steer>] [--dry-run] [--return-preamble] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'to',
      'from',
      'run',
      'inject',
      'delivery',
      'dry-run',
      'return-preamble',
      'retry-request'
    ],
    identityFlagRoles: { from: 'caller' },
    notes: [ORCHESTRATION_DISPATCH_DELIVERY_NOTE]
  },
  {
    path: ['orchestration', 'request-show'],
    summary: 'Ask whether one orchestration mutation request already took effect',
    usage: 'orca orchestration request-show --request <request_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'request'],
    notes: [
      'Read-only: it never starts, retries, or settles anything, so it is safe to run after any lost response.',
      'completed means the mutation landed and --retry-request replays the recorded outcome instead of starting a second one. pending means the original mutation is still running or Orca restarted before recording its outcome; wait for a live original command, otherwise replay with --retry-request.',
      'absent means this runtime holds no receipt for that request under your caller identity: it never arrived, it failed before recording anything, or the receipt was pruned. Absent is not proof that nothing happened.'
    ]
  },
  {
    path: ['orchestration', 'dispatch-show'],
    summary: 'Show dispatch context for a task',
    usage:
      'orca orchestration dispatch-show --task <task_id> [--preamble] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'preamble', 'from'],
    identityFlagRoles: { from: 'target' }
  },
  {
    path: ['orchestration', 'ask'],
    summary: 'Ask the coordinator a question and block until answered',
    usage:
      'orca orchestration ask (--question <text> | --resume <message_id>) [--to <run:id>] [--run <run_id>] [--options <csv>] [--timeout-ms <n>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'to',
      'run',
      'question',
      'resume',
      'dispatch-capability',
      'options',
      'timeout-ms',
      'from',
      'retry-request'
    ],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'From an active Dispatch, a new question defaults to its owning Run mailbox.',
      'Timeout leaves the question pending; resume with the original message ID.'
    ]
  },
  {
    path: ['orchestration', 'coordinator-start'],
    aliases: [['orchestration', 'run']],
    summary: 'Retired: load the current orchestration skill',
    usage:
      'orca orchestration coordinator-start --spec <text> [--from <handle>] [--poll-interval-ms <n>] [--max-concurrent <n>] [--worktree <selector>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'spec',
      'from',
      'poll-interval-ms',
      'max-concurrent',
      'worktree'
    ],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'This command performs no effects and returns the exact `skills get orchestration --full` recovery action.',
      'Use the lightweight Run, Task, and worker-start primitives described by the current skill.'
    ]
  },
  {
    path: ['orchestration', 'coordinator-stop'],
    aliases: [['orchestration', 'run-stop']],
    summary: 'Retired: load the current orchestration skill',
    usage: 'orca orchestration coordinator-stop [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'This command performs no effects and returns the exact `skills get orchestration --full` recovery action.'
    ]
  },
  {
    path: ['orchestration', 'gate-create'],
    summary: 'Create a decision gate blocking a task',
    usage:
      'orca orchestration gate-create --task <task_id> --question <text> [--options <json_array>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'question', 'options', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' }
  },
  {
    path: ['orchestration', 'gate-resolve'],
    summary: 'Resolve a pending decision gate',
    usage:
      'orca orchestration gate-resolve --id <gate_id> --resolution <text> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'resolution', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' }
  },
  {
    path: ['orchestration', 'gate-list'],
    summary: 'List decision gates',
    usage:
      'orca orchestration gate-list [--task <task_id>] [--status <status>] [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'status', 'run', 'from'],
    identityFlagRoles: { from: 'caller' },
    notes: ['--run inspects a named Run without binding; otherwise gates are scoped to the caller.']
  },
  {
    path: ['orchestration', 'reset'],
    summary: 'Reset one explicit orchestration state scope',
    usage:
      'orca orchestration reset (--all | --tasks | --messages) [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'all', 'tasks', 'messages', 'retry-request']
  }
]
