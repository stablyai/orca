import { GLOBAL_FLAGS, type CommandSpec } from '../args'
import { ORCHESTRATION_GATE_COMMAND_SPECS } from './orchestration-gate-specs'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from './orchestration-worker-specs'

export const ORCHESTRATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'run-create'],
    summary: 'Create and bind a lightweight orchestration Run',
    usage:
      'orca orchestration run-create --objective <text> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'objective', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'A Run is a namespace and home inbox. It never schedules or places workers. worker-start --spec creates one when none is bound; use run-create for Task graphs or a new goal.',
      '--retry-request is only for exact recovery after an unknown mutation result.'
    ]
  },
  {
    path: ['orchestration', 'run-use'],
    summary: 'Resume coordinating a Run',
    usage:
      'orca orchestration run-use --id <run_id> [--from <handle>] [--takeover-legacy] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'from', 'takeover-legacy', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'A worker cannot bind its own or ancestor Run or use --takeover-legacy. --takeover-legacy must run in the live coordinator agent terminal it binds; it preserves existing worker assignments.'
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
    usage: 'orca orchestration run-show --id <run_id> [--removed] [--cursor <cursor>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'removed', 'cursor']
  },
  {
    path: ['orchestration', 'send'],
    summary: 'Send an inter-agent message',
    usage:
      'orca orchestration send --subject <text> [--to <run:id|dispatch:id|legacy_handle>] [--run <run_id>] [--from <handle>] [--body <text>] [--type <type>] [--priority <level>] [--thread-id <id>] [--payload <json>] [--task-id <id>] [--dispatch-id <id>] [--outcome <succeeded|failed>] [--files-modified <csv>] [--report-path <path>] [--phase <text>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'to',
      'run',
      'from',
      'subject',
      'body',
      'type',
      'priority',
      'thread-id',
      'payload',
      'task-id',
      'dispatch-id',
      'dispatch-capability',
      'retry-request',
      'outcome',
      'files-modified',
      'report-path',
      'phase'
    ],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Valid --type values: status, dispatch, worker_done, merge_ready, escalation, handoff, decision_gate, question, heartbeat.',
      'To answer a worker question, use orchestration reply --id <msg_id> --body <text> with the same Orca CLI executable.',
      'Group addresses (@all, @idle, @codex, ...) reach the live Dispatches of your own Run; a sender in no Run must use run:<id> or dispatch:<id>. @worktree:<id> names one workspace.',
      'Run groups exclude their owning coordinator; send to run:<id> to raise something with yours. Nested coordinators receive group mail in their child Run mailbox; @worktree:<id> includes workspace coordinators.',
      'On Windows PowerShell, quote group addresses such as --to "@all" or --to "@worktree:<id>".',
      "worker_done and heartbeat are exact-Dispatch signals and cannot target groups; omit --to to use the Dispatch's Run mailbox.",
      'worker_done requires --outcome succeeded or --outcome failed.',
      'From an active Dispatch, an omitted recipient defaults to its owning Run mailbox.',
      'Use --to dispatch:<id> for attempt-specific coordinator guidance; Orca durably relays it to a connected worker server.',
      'A worker_done with the active task/dispatch IDs completes that task only from the dispatched pane. When stable pane identity is unavailable, the sender handle must exactly match the dispatch assignee; injected preambles include the correct --from value.',
      'Prefer --task-id/--dispatch-id/etc. over raw --payload JSON in worker commands; PowerShell strips JSON quotes easily.'
    ]
  },
  {
    path: ['orchestration', 'check'],
    summary: "Check this agent's messages",
    usage:
      'orca orchestration check [--terminal <handle>] [--run <run_id>] [--ack <delivery_id>] [--unread | --peek | --all] [--types <type,...>] [--format] [--wait] [--timeout-ms <n>] [--retry-request <id>] [--json]\n' +
      "  default: return the bound Run's oldest unread FIFO batch and mark it handled.\n" +
      '  --ack: optional; acknowledges a batch from an older Orca that does not mark it.\n' +
      '  --peek: return only unread messages without marking them read.\n' +
      '  --all: return recent messages for the handle; does not mark read.\n' +
      '  --wait: block until a matching message arrives or --timeout-ms expires.\n' +
      '          Emits JSON keepalive lines to stderr every 15s so the caller can\n' +
      '          tell the process is alive. `_keepalive` is unrelated to heartbeat\n' +
      '          messages; `_heartbeat` remains as a deprecated compatibility alias.\n' +
      '          Filter with `jq "select(._keepalive|not)"` when merging streams.',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'terminal',
      'run',
      'ack',
      'unread',
      'peek',
      'all',
      'types',
      'format',
      'wait',
      'timeout-ms',
      'retry-request'
    ],
    identityFlagRoles: { terminal: 'caller' },
    notes: [
      'On Windows PowerShell, quote comma-separated type filters, e.g. --types "worker_done,escalation".',
      '--types is the wake condition for --wait; a returned Delivery is always the whole FIFO batch, so it is never filtered by type. Without --wait it has no effect on consuming checks. Only --peek and --all filter their rows.',
      '--format renders the returned rows as local text only; it never writes to another terminal.',
      "A consuming check marks the batch it returns as handled, so the next check returns newer mail; no --ack is needed. Several --wait calls may wait on one inbox; waiting reserves nothing, listeners woken by the same arrival get the same Delivery, and --ack of a handled Delivery is a no-op. Consuming checks belong to the agent itself. A script that only watches the inbox must use --peek (including --peek --wait) and must never --ack, or it takes mail the agent never sees. If a check response was lost, rerun it with the --retry-request it printed to get the same batch. To find mail after losing context, run orca orchestration inbox --terminal <mailbox> --limit <n> --full and name the mailbox: run:<run_id> for a coordinator's bound Run, or dispatch:<dispatch_id> for a worker, including mail it read before it bound a helper Run."
    ]
  },
  {
    path: ['orchestration', 'reply'],
    summary: 'Reply to a message',
    usage:
      'orca orchestration reply --id <msg_id> --body <text> [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'body', 'run', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' }
  },
  {
    path: ['orchestration', 'inbox'],
    summary: 'Show messages across (or for) recipients',
    usage: 'orca orchestration inbox [--limit <n>] [--terminal <handle>] [--full] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'terminal', 'full'],
    identityFlagRoles: { terminal: 'target' }
  },
  {
    path: ['orchestration', 'task-create'],
    summary: 'Create an orchestration task',
    usage:
      'orca orchestration task-create (--spec <text> | --spec-file <path|->) [--task-title <text>] [--display-name <text>] [--deps <json_array>] [--parent <task_id>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'spec',
      'spec-file',
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
    notes: [
      'Rows show id, status, and title; --full adds each spec and result, where --brief collapses whitespace and caps each spec at 160 characters.'
    ]
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
    identityFlagRoles: { from: 'caller' }
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
    summary: 'Ask the coordinator a question; Orca wakes you with the answer',
    usage:
      'orca orchestration ask (--question <text> | --resume <message_id>) [--to <run:id>] [--run <run_id>] [--options <csv>] [--wait] [--timeout-ms <n>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'to',
      'run',
      'question',
      'resume',
      'dispatch-capability',
      'options',
      'wait',
      'timeout-ms',
      'from',
      'retry-request'
    ],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'From an active Dispatch, a new question goes to its owning Run mailbox and ask returns at once: end your turn, and Orca wakes you with the answer as mail. --wait and --resume block until the answer instead; --timeout-ms accepts 1 to 1800000 ms per wait (default 600000 = 10 minutes, max 30 minutes), and a timeout leaves the question pending.'
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
  ...ORCHESTRATION_GATE_COMMAND_SPECS,
  {
    path: ['orchestration', 'reset'],
    destructive: true,
    summary: 'Reset one explicit orchestration state scope',
    usage:
      'orca orchestration reset (--all | --tasks | --messages) [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'all', 'tasks', 'messages', 'retry-request']
  }
]
