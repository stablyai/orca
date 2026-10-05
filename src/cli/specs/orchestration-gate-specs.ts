import { GLOBAL_FLAGS, type CommandSpec } from '../args'
import { orchestrationFlagHelp } from './orchestration-flag-help'

export const ORCHESTRATION_GATE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'gate-create'],
    summary: 'Create a decision gate blocking a task',
    usage:
      'orca orchestration gate-create --task <task_id> --question <text> [--options <json_array>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'question', 'options', 'from', 'retry-request'],
    flagHelp: orchestrationFlagHelp({
      task: '<task_id> Task the gate blocks',
      question: '<text> Decision the gate asks for',
      options: '<json_array> JSON array of allowed resolutions'
    }),
    identityFlagRoles: { from: 'caller' }
  },
  {
    path: ['orchestration', 'gate-resolve'],
    summary: 'Resolve a pending decision gate',
    usage:
      'orca orchestration gate-resolve --id <gate_id> --resolution <text> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'resolution', 'from', 'retry-request'],
    flagHelp: orchestrationFlagHelp({
      id: '<gate_id> Pending gate to resolve',
      resolution: '<text> Chosen resolution'
    }),
    identityFlagRoles: { from: 'caller' }
  },
  {
    path: ['orchestration', 'gate-list'],
    summary: 'List decision gates',
    usage:
      'orca orchestration gate-list [--task <task_id>] [--status <status>] [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'status', 'run', 'from'],
    flagHelp: orchestrationFlagHelp({
      task: '<task_id> Only gates for this task',
      status: '<status> Only gates with this status: pending, resolved, or timeout',
      run: '<run_id> Inspect this Run without binding to it'
    }),
    identityFlagRoles: { from: 'caller' },
    notes: ['--run inspects a named Run without binding; otherwise gates are scoped to the caller.']
  }
]
