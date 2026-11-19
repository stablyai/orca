import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
import type { CommandSpec } from '../discovery/command-spec'

export const ORCHESTRATION_TASK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'task-create'],
    summary: 'Create an orchestration task',
    usage:
      'orca orchestration task-create (--spec <text> | --spec-file <path|->) [--task-title <text>] [--display-name <text>] [--model <model>] [--effort <effort>] [--deps <json_array>] [--parent <task_id>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'spec',
      'spec-file',
      'task-title',
      'display-name',
      'model',
      'effort',
      'deps',
      'parent',
      'run',
      'from',
      'retry-request'
    ],
    identityFlagRoles: { from: 'caller' },
    notes: [
      '--model and --effort save defaults for fresh worker-start --task launches, including retries. --effort requires --model; agent/model compatibility is checked when the worker starts. An explicit worker-start --model replaces both defaults; --effort alone overrides the task effort. Reusing --terminal keeps its running configuration.'
    ]
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
  }
]
