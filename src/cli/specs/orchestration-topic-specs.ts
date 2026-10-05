import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_TOPIC_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'topic-set'],
    summary: 'Set one Task topic publish/subscribe policy',
    usage:
      'orca orchestration topic-set --task <task_id> --publishes <json_array> --subscribes <json_array> [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'publishes',
      'subscribes',
      'run',
      'from',
      'retry-request'
    ],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Topic names are lowercase identifiers using letters, digits, dots, underscores, slashes, or hyphens.',
      'This policy only controls routing. Topic messages still use orchestration send/check and the existing durable mailbox lifecycle.'
    ]
  },
  {
    path: ['orchestration', 'topic-show'],
    summary: 'Show one Task topic publish/subscribe policy',
    usage:
      'orca orchestration topic-show --task <task_id> [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'run', 'from'],
    identityFlagRoles: { from: 'caller' }
  }
]
