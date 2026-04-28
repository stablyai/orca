import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'send'],
    summary: 'Send an inter-agent message',
    usage:
      'orca orchestration send --to <handle> --subject <text> [--from <handle>] [--body <text>] [--type <type>] [--priority <level>] [--thread-id <id>] [--payload <json>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'to',
      'from',
      'subject',
      'body',
      'type',
      'priority',
      'thread-id',
      'payload'
    ]
  },
  {
    path: ['orchestration', 'check'],
    summary: 'Check messages for a terminal',
    usage:
      'orca orchestration check [--terminal <handle>] [--unread] [--types <type,...>] [--inject] [--wait] [--timeout-ms <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'unread', 'types', 'inject', 'wait', 'timeout-ms']
  },
  {
    path: ['orchestration', 'reply'],
    summary: 'Reply to a message',
    usage: 'orca orchestration reply --id <msg_id> --body <text> [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'body', 'from']
  },
  {
    path: ['orchestration', 'inbox'],
    summary: 'Show all messages across recipients',
    usage: 'orca orchestration inbox [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit']
  },
  {
    path: ['orchestration', 'task-create'],
    summary: 'Create an orchestration task',
    usage:
      'orca orchestration task-create --spec <text> [--deps <json_array>] [--parent <task_id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'spec', 'deps', 'parent']
  },
  {
    path: ['orchestration', 'task-list'],
    summary: 'List orchestration tasks',
    usage: 'orca orchestration task-list [--status <status>] [--ready] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'status', 'ready']
  },
  {
    path: ['orchestration', 'task-update'],
    summary: 'Update a task status',
    usage:
      'orca orchestration task-update --id <task_id> --status <status> [--result <json>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'status', 'result']
  },
  {
    path: ['orchestration', 'dispatch'],
    summary: 'Dispatch a task to a terminal',
    usage:
      'orca orchestration dispatch --task <task_id> --to <handle> [--from <handle>] [--inject] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'to', 'from', 'inject']
  },
  {
    path: ['orchestration', 'dispatch-show'],
    summary: 'Show dispatch context for a task',
    usage: 'orca orchestration dispatch-show --task <task_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task']
  },
  {
    path: ['orchestration', 'run'],
    summary: 'Start the coordinator loop',
    usage:
      'orca orchestration run --spec <text> [--from <handle>] [--poll-interval-ms <n>] [--max-concurrent <n>] [--worktree <selector>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'spec',
      'from',
      'poll-interval-ms',
      'max-concurrent',
      'worktree'
    ]
  },
  {
    path: ['orchestration', 'run-stop'],
    summary: 'Stop the active coordinator run',
    usage: 'orca orchestration run-stop [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['orchestration', 'gate-create'],
    summary: 'Create a decision gate blocking a task',
    usage:
      'orca orchestration gate-create --task <task_id> --question <text> [--options <json_array>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'question', 'options']
  },
  {
    path: ['orchestration', 'gate-resolve'],
    summary: 'Resolve a pending decision gate',
    usage: 'orca orchestration gate-resolve --id <gate_id> --resolution <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'resolution']
  },
  {
    path: ['orchestration', 'gate-list'],
    summary: 'List decision gates',
    usage: 'orca orchestration gate-list [--task <task_id>] [--status <status>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'status']
  },
  {
    path: ['orchestration', 'reset'],
    summary: 'Reset orchestration state',
    usage: 'orca orchestration reset [--all] [--tasks] [--messages] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'all', 'tasks', 'messages']
  }
]
