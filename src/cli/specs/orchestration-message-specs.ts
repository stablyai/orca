import { GLOBAL_FLAGS, type CommandSpec } from '../args'
import { orchestrationFlagHelp } from './orchestration-flag-help'

export const ORCHESTRATION_MESSAGE_COMMAND_SPECS: CommandSpec[] = [
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
    flagHelp: orchestrationFlagHelp({
      to: '<recipient> Run, Dispatch, group, or legacy terminal recipient',
      subject: '<text> Message subject',
      body: '<text> Message body',
      type: '<type> Message type such as status, heartbeat, or worker_done',
      priority: '<level> Message priority',
      'thread-id': '<id> Existing message thread',
      payload: '<json> Structured message payload',
      'task-id': '<id> Task for a Dispatch lifecycle signal',
      'dispatch-id': '<id> Dispatch for a lifecycle signal',
      outcome: '<succeeded|failed> Worker outcome',
      'files-modified': '<csv> Paths changed by the worker',
      'report-path': '<path> Worker long-form report',
      phase: '<text> Current worker phase for a heartbeat'
    }),
    notes: [
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
    summary: 'Check messages for a terminal',
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
    flagHelp: orchestrationFlagHelp({
      terminal: '<handle> Terminal whose messages to inspect',
      ack: '<delivery_id> Delivery to acknowledge before checking again',
      unread: 'Return only unread messages',
      peek: 'Return unread messages without marking them read',
      all: 'Return all messages without marking them read',
      types: '<type,...> Message types that wake a waiter',
      format: 'Render returned messages as local text',
      wait: 'Wait until a matching message arrives',
      'timeout-ms': '<n> Maximum time to wait for a matching message'
    }),
    notes: [
      'On Windows PowerShell, quote comma-separated type filters, e.g. --types "worker_done,escalation".',
      '--format renders the returned rows as local text only; it never writes to another terminal.',
      'A bound Run replays the same Delivery until --ack; process every message before acknowledging.'
    ]
  },
  {
    path: ['orchestration', 'reply'],
    summary: 'Reply to a message',
    usage:
      'orca orchestration reply --id <msg_id> --body <text> [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'body', 'run', 'from', 'retry-request'],
    flagHelp: orchestrationFlagHelp({
      id: '<msg_id> Message to reply to',
      body: '<text> Reply body'
    })
  },
  {
    path: ['orchestration', 'inbox'],
    summary: 'Show messages across (or for) recipients',
    usage: 'orca orchestration inbox [--limit <n>] [--terminal <handle>] [--full] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'terminal', 'full'],
    flagHelp: orchestrationFlagHelp({
      limit: '<n> Maximum number of messages to return',
      terminal: '<handle> Restrict messages to one terminal',
      full: 'Include message bodies and payloads'
    })
  }
]
