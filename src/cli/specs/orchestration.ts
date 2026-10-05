import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
import { orchestrationFlagHelp } from './orchestration-flag-help'
import { ORCHESTRATION_GATE_COMMAND_SPECS } from './orchestration-gate-specs'
import { ORCHESTRATION_MESSAGE_COMMAND_SPECS } from './orchestration-message-specs'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from './orchestration-worker-specs'

export const ORCHESTRATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'run-create'],
    summary: 'Create and bind a lightweight orchestration Run',
    usage:
      'orca orchestration run-create --objective <text> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'objective', 'from', 'retry-request'],
    flagHelp: orchestrationFlagHelp({
      objective: '<text> Objective recorded on the new Run',
      from: '<handle> Coordinator to bind the new Run to; defaults to this terminal or agent session'
    }),
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
    flagHelp: orchestrationFlagHelp({
      id: '<run_id> Run to bind this coordinator to',
      from: '<handle> Coordinator to bind; defaults to this terminal or agent session',
      'takeover-legacy':
        'Take over the automatically adopted Run while it still has live legacy work'
    }),
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
    flagHelp: orchestrationFlagHelp({
      from: '<handle> Coordinator whose bound Run to show; defaults to this terminal or agent session'
    }),
    identityFlagRoles: { from: 'caller' }
  },
  {
    path: ['orchestration', 'run-list'],
    summary: 'List lightweight orchestration Runs',
    usage: 'orca orchestration run-list [--limit <n>] [--cursor <cursor>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'cursor'],
    flagHelp: orchestrationFlagHelp({
      limit: '<n> Maximum number of Runs per page (default 100)',
      cursor: '<cursor> Opaque cursor printed by the previous run-list page'
    })
  },
  {
    path: ['orchestration', 'run-show'],
    summary: 'Show one lightweight orchestration Run',
    usage: 'orca orchestration run-show --id <run_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    flagHelp: orchestrationFlagHelp({
      id: '<run_id> Run to show'
    })
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
    flagHelp: orchestrationFlagHelp({
      spec: '<text> Full task instructions',
      'task-title': '<text> Concise title for the orchestration task',
      'display-name': '<text> UI label shown for dispatched worker rows',
      deps: '<json_array> JSON array of prerequisite task ids',
      parent: '<task_id> Parent task'
    }),
    identityFlagRoles: { from: 'caller' }
  },
  {
    path: ['orchestration', 'task-list'],
    summary: 'List orchestration tasks',
    usage:
      'orca orchestration task-list [--status <status>] [--ready] [--brief] [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'status', 'ready', 'brief', 'run', 'from'],
    flagHelp: orchestrationFlagHelp({
      status: '<status> Only tasks with this status',
      ready: 'Only tasks that are ready to dispatch',
      brief: 'Collapse whitespace and cap each spec at 160 characters',
      run: "<run_id> Run to list instead of the caller's bound Run"
    }),
    identityFlagRoles: { from: 'caller' },
    notes: ['--brief collapses whitespace and caps each spec at 160 characters.']
  },
  {
    path: ['orchestration', 'task-update'],
    summary: 'Update a task status',
    usage:
      'orca orchestration task-update --id <task_id> --status <status> [--result <text>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'status', 'result', 'run', 'from', 'retry-request'],
    flagHelp: orchestrationFlagHelp({
      id: '<task_id> Task to update',
      status: '<status> pending, ready, dispatched, completed, failed, or blocked',
      result: '<text> Result recorded with the status, such as cancelled'
    }),
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
      'orca orchestration dispatch --task <task_id> --to <handle> [--from <handle>] [--run <run_id>] [--inject] [--dry-run] [--return-preamble] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'to',
      'from',
      'run',
      'inject',
      'dry-run',
      'return-preamble',
      'retry-request'
    ],
    flagHelp: orchestrationFlagHelp({
      task: '<task_id> Ready task to dispatch',
      to: '<handle> Terminal that receives the task; optional with --dry-run',
      inject: 'Send the worker preamble to the agent running in the --to terminal',
      'dry-run': 'Preview the worker preamble without creating a Dispatch',
      'return-preamble': 'Include the worker preamble in the result'
    }),
    identityFlagRoles: { from: 'caller' }
  },
  {
    path: ['orchestration', 'request-show'],
    summary: 'Ask whether one orchestration mutation request already took effect',
    usage: 'orca orchestration request-show --request <request_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'request'],
    flagHelp: orchestrationFlagHelp({
      request: '<request_id> Request id Orca reported for the mutation'
    }),
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
    flagHelp: orchestrationFlagHelp({
      task: '<task_id> Task whose Dispatch to show',
      preamble: 'Print the worker preamble for the Dispatch',
      from: '<handle> Coordinator handle written into the --preamble text'
    }),
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
    flagHelp: orchestrationFlagHelp({
      to: '<run:id> Run mailbox for a new question',
      question: '<text> New question for the coordinator',
      resume: '<message_id> Pending question to keep waiting on',
      options: '<csv> Comma-separated answer choices for a new question',
      'timeout-ms': '<n> Maximum wait for an answer (default 600000, max 1800000)'
    }),
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
    flagHelp: orchestrationFlagHelp({
      spec: '<text> Ignored; this command is retired',
      from: '<handle> Ignored; this command is retired',
      'poll-interval-ms': '<n> Ignored; this command is retired',
      'max-concurrent': '<n> Ignored; this command is retired',
      worktree: '<selector> Ignored; this command is retired'
    }),
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
  ...ORCHESTRATION_GATE_COMMAND_SPECS,
  {
    path: ['orchestration', 'reset'],
    summary: 'Reset one explicit orchestration state scope',
    usage:
      'orca orchestration reset (--all | --tasks | --messages) [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'all', 'tasks', 'messages', 'retry-request'],
    flagHelp: orchestrationFlagHelp({
      all: 'Delete every Run, task, Dispatch, gate, and message',
      tasks: 'Delete tasks, Dispatches, and gates; keep Runs and messages',
      messages: 'Delete messages and deliveries; keep Runs and tasks'
    })
  }
]
