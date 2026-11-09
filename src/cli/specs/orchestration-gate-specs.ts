import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const ORCHESTRATION_GATE_COMMAND_SPECS: CommandSpec[] = [
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
  }
]
