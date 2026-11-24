import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
import type { CommandSpec } from '../discovery/command-spec'

export const ORCHESTRATION_RUN_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'briefing'],
    summary: 'Summarize orchestration goals, task counts, and decisions waiting for you',
    usage: 'orca orchestration briefing [--cursor <cursor>] [--environment <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'cursor', 'from'],
    notes: [
      'Reads eight Runs per page on the selected runtime. Each goal includes status counts and up to three pending questions. Pass nextCursor to continue or use gate-list --run <id> --status pending to read every decision.',
      'A null count and a read error mean the runtime could not report it. Use project setups to list registered projects, including projects with no Run.'
    ]
  },
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
  }
]
