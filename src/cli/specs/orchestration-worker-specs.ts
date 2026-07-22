import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const ORCHESTRATION_WORKER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'worker-start'],
    summary: 'Start one supervised worker on the Run home or a connected Orca server',
    usage:
      'orca orchestration worker-start --task <task_id> [--on <saved-environment>] [--worktree <current|selector|new-child|new-top-level>] (--agent <agent> | --terminal <handle>) [--name <name>] [--repo <selector>] [--base-branch <ref>] [--setup <run|skip|inherit>] [--retry-of <dispatch_id>] [--timeout-ms <n>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'on',
      'worktree',
      'name',
      'repo',
      'base-branch',
      'display-name',
      'comment',
      'setup',
      'agent',
      'terminal',
      'retry-of',
      'timeout-ms',
      'run',
      'from',
      'retry-request'
    ],
    notes: [
      'Current and existing worktrees never rerun setup; a fresh agent terminal is created unless --terminal is explicit.',
      'New worktrees use agent-first creation and default --setup to run; skip or inherit must be explicit.',
      '--on selects only the worker server; the Run and this command remain on the current Orca server.',
      'Remote current and new-child are invalid; discover an exact remote selector or use new-top-level.',
      'The call returns only after agent readiness and lifecycle input acceptance, a known failure, or an unknown outcome.'
    ]
  },
  {
    path: ['orchestration', 'worker-show'],
    summary: 'Inspect one supervised worker Dispatch',
    usage: 'orca orchestration worker-show --dispatch <dispatch_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch']
  },
  {
    path: ['orchestration', 'worker-read'],
    summary: 'Read bounded output from a supervised worker terminal',
    usage:
      'orca orchestration worker-read --dispatch <dispatch_id> [--cursor <n>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'cursor', 'limit']
  },
  {
    path: ['orchestration', 'worker-stop'],
    summary: 'Fence and stop only one supervised agent terminal',
    usage:
      'orca orchestration worker-stop --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    notes: ['Never deletes the worktree, setup terminal, configured tabs, or unrelated processes.']
  },
  {
    path: ['orchestration', 'worker-abandon'],
    summary: 'Fence a worker without claiming its process stopped',
    usage:
      'orca orchestration worker-abandon --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    notes: ['Retains all possibly-live resources and performs no process or filesystem action.']
  }
]
