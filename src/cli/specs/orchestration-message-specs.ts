import { GLOBAL_FLAGS, type CommandSpec } from '../args'

const ORCHESTRATION_DELIVERY_NOTE =
  '--delivery steer: a busy chat gets the "you have mail" notice in its running turn instead of as a queued card; an agent that runs one prompt at a time ends its turn and takes it next, as a person\'s Send now does. While an approval or question is open the notice waits for the answer. Default queue. Terminal agents get mail at their next idle point or check --wait.'

export const ORCHESTRATION_DISPATCH_DELIVERY_NOTE =
  '--delivery (either value) needs --inject. With steer, a busy chat takes the task into its running turn (an agent that runs one prompt at a time ends its turn first) instead of as a queued card, or as a card while an approval or question is open. A task reported handed to the chat but not taken yet can still be dropped if that turn ends without taking it (say the person presses Stop); if no report arrives, check on the worker. A task to a terminal is typed in at once either way.'

/** The verbs that move messages between agents: send, check, reply, inbox. */
export const ORCHESTRATION_MESSAGE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'send'],
    summary: 'Send an inter-agent message',
    usage:
      'orca orchestration send --subject <text> [--to <run:id|dispatch:id|legacy_handle>] [--run <run_id>] [--from <handle>] [--body <text>] [--type <type>] [--priority <level>] [--delivery <queue|steer>] [--thread-id <id>] [--payload <json>] [--task-id <id>] [--dispatch-id <id>] [--outcome <succeeded|failed>] [--files-modified <csv>] [--report-path <path>] [--phase <text>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'to',
      'run',
      'from',
      'subject',
      'body',
      'type',
      'priority',
      'delivery',
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
      'Prefer --task-id/--dispatch-id/etc. over raw --payload JSON in worker commands; PowerShell strips JSON quotes easily.',
      ORCHESTRATION_DELIVERY_NOTE
    ]
  },
  {
    path: ['orchestration', 'check'],
    summary: "Check this agent's messages",
    usage:
      'orca orchestration check [--terminal <handle>] [--run <run_id>] [--ack <delivery_id>] [--unread | --peek | --all] [--types <type,...>] [--format] [--wait] [--timeout-ms <n>] [--retry-request <id>] [--json]\n' +
      "  default: return the bound Run's oldest unacknowledged FIFO batch.\n" +
      '  --ack: acknowledge the prior whole batch before checking/waiting.\n' +
      '  --peek: return only unread messages without marking them read.\n' +
      '  --all: return every message for the handle; does not mark read.\n' +
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
      'A bound Run replays the same Delivery until --ack or all its messages are marked read, even with --types; process every message before acknowledging.'
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
  }
]
