import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const ORCHESTRATION_RUN_COMMAND_SPECS: CommandSpec[] = [
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
    summary: 'Resume coordinating a Run',
    usage:
      'orca orchestration run-use --id <run_id> [--from <handle>] [--takeover] [--takeover-legacy] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'from', 'takeover', 'takeover-legacy', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Refused while another coordinator of the Run is still open; --takeover replaces it, and its unacknowledged mail is replayed to you. A worker cannot bind its own or ancestor Run or use either takeover flag. Other Runs require Task ownership or an explicit run-handover, even when the prior coordinator is absent or unverifiable. --takeover-legacy must run in the live coordinator agent terminal it binds; it preserves existing worker assignments.'
    ]
  },
  {
    path: ['orchestration', 'run-handover'],
    summary: 'Authorize a Task or exact caller to accept this Run',
    usage:
      'orca orchestration run-handover --id <run_id> (--to-task <task_id> | --to <address>) [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'from', 'to-task', 'to', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Only the current or last proven coordinator may issue a hand-over; issuing it does not move the Run.',
      'The recipient accepts with run-use. The grant ends on acceptance, replacement, 24 hours, Run deletion, or a different coordinator taking the Run. Leaving the Run preserves it.',
      'Use a local Task target for replacement-worker inheritance; a caller target authorizes only that exact agent process.'
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
  }
]
