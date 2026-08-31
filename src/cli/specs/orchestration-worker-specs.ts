import { GLOBAL_FLAGS, type CommandSpec } from '../args'
import { orchestrationFlagHelp } from './orchestration-flag-help'

const WORKER_FLAG_HELP = {
  dispatch: '<dispatch_id> Target the supervised worker Dispatch by id',
  'retry-request': '<id> Retry the exact mutation after an unknown result',
  run: '<run_id> Filter workers by orchestration Run id'
} satisfies Record<string, string>

function workerFlagHelp(overrides: Record<string, string> = {}): Record<string, string> {
  return orchestrationFlagHelp({ ...WORKER_FLAG_HELP, ...overrides })
}

export const ORCHESTRATION_WORKER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'worker-start'],
    summary: 'Start one supervised worker on the Run home or a connected Orca server',
    usage:
      'orca orchestration worker-start --task <task_id> [--on <saved-environment>] [--worktree <current|selector|new-child|new-top-level>] (--agent <agent> | --terminal <handle>) [--model <id>] [--effort <level>] [--name <name>] [--repo <selector>] [--base-branch <ref>] [--display-name <text>] [--comment <text>] [--setup <run|skip|inherit>] [--retry-of <dispatch_id>] [--timeout-ms <n>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
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
      'model',
      'effort',
      'terminal',
      'retry-of',
      'timeout-ms',
      'run',
      'from',
      'retry-request'
    ],
    flagHelp: workerFlagHelp({
      task: '<task_id> Task to assign to the worker',
      on: '<environment> Saved environment where the worker should run',
      worktree:
        '<placement> Worker placement; required with --terminal, where current means the coordinator worktree',
      name: '<name> Name for a newly created worktree',
      repo: '<selector> Repository for a new top-level worktree',
      'base-branch': '<ref> Base ref for a newly created worktree',
      'display-name': '<text> Display name for a newly created worktree',
      comment: '<text> Comment for a newly created worktree',
      setup: '<policy> Setup policy for a newly created worktree',
      agent: '<agent> TUI agent to launch in a fresh terminal',
      model: '<id> Provider model id for a fresh agent launch',
      effort: '<level> Reasoning effort for the selected model',
      terminal: '<handle> Existing agent terminal to reuse with its --worktree placement',
      'retry-of': '<dispatch_id> Prior Dispatch that this attempt replaces',
      'timeout-ms': '<n> Maximum time to wait for worker readiness',
      run: '<run_id> Run containing the task',
      from: '<handle> Coordinator terminal used as caller identity'
    }),
    notes: [
      'Current and existing worktrees never rerun setup; a fresh agent terminal is created unless --terminal is explicit.',
      'When reusing --terminal, pass --worktree for that terminal; current means the coordinator worktree.',
      '--model supports Claude, Codex, and Cursor opaque provider model ids; --effort requires --model. Neither can combine with --terminal.',
      'New worktrees use agent-first creation and default --setup to run. Repository start-immediately runs setup beside the agent; wait-for-setup gates agent readiness and task input.',
      'Creation flags (--name, --repo, --base-branch, --display-name, --comment, --setup) are rejected for current/existing worktrees. Use exact --repo on the selected server; project/host convenience routing remains on worktree create.',
      '--on selects only the worker server; the Run and this command remain on the current Orca server.',
      'Remote current and new-child are invalid; discover an exact remote selector or use new-top-level.',
      '--retry-of links the replacement attempt but does not inherit placement; repeat the intended --on/worktree and --agent/terminal choices.',
      'The call exits 0 only for ready. Failed or outcome_unknown exits 1 and JSON includes stage/failedStage, setup, effects, residualResources, and recovery commands when needed.'
    ]
  },
  {
    path: ['orchestration', 'worker-show'],
    summary: 'Inspect one supervised worker Dispatch',
    usage: 'orca orchestration worker-show --dispatch <dispatch_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch'],
    flagHelp: workerFlagHelp(),
    notes: [
      'A Dispatch created by orchestration dispatch is shown as unsupervised and reports the exact adopted terminal when its identity is still provable.',
      'observation.agentWait names a worker parked on a prompt only a human can answer, with the evidence that proved it (hook, prompt-text, or title). Null means Orca looked and found no wait. An absent field means it never looked — an older host, an unverifiable worker identity, an unreadable pane, or an agent probe that did not answer in time — and never means the worker is not waiting. A waiting worker is healthy, not failed.'
    ]
  },
  {
    path: ['orchestration', 'worker-read'],
    summary: 'Read bounded output from one supervised worker',
    usage:
      'orca orchestration worker-read --dispatch <dispatch_id> [--source <auto|transcript|terminal>] [--cursor <cursor>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'source', 'cursor', 'limit'],
    flagHelp: workerFlagHelp({
      source: '<source> Output source: auto, transcript, or terminal',
      cursor: '<cursor> Opaque cursor returned by a previous worker-read page',
      limit: '<n> Maximum number of output rows to return'
    }),
    notes: [
      'The default auto source uses an exact hook-reported transcript when available and otherwise returns labeled terminal output.',
      'A Dispatch created by orchestration dispatch reads from its adopted terminal with worker status unsupervised.',
      'A returned cursor is pinned to the exact source; start a fresh read if Orca reports source_changed.'
    ]
  },
  {
    path: ['orchestration', 'worker-stop'],
    summary: 'Fence one Dispatch and stop its supervised agent terminal',
    usage:
      'orca orchestration worker-stop --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    flagHelp: workerFlagHelp(),
    notes: [
      'A Dispatch created by orchestration dispatch is fenced without closing its unsupervised terminal process.',
      'Never deletes the worktree, setup terminal, configured tabs, or unrelated processes.'
    ]
  },
  {
    path: ['orchestration', 'worker-abandon'],
    summary: 'Fence a worker without claiming its process stopped',
    usage:
      'orca orchestration worker-abandon --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    flagHelp: workerFlagHelp(),
    notes: ['Retains all possibly-live resources and performs no process or filesystem action.']
  },
  {
    path: ['orchestration', 'worker-release'],
    summary: 'Release the terminal of one settled supervised worker',
    usage:
      'orca orchestration worker-release --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    flagHelp: workerFlagHelp(),
    notes: [
      'Post-completion cleanup for a settled (succeeded or failed) worker; closes only the exact coordinator-owned agent terminal of that worker.',
      'A settled Dispatch created by orchestration dispatch has no owned terminal resource and is reported retained without process action.',
      'An inspectable output archive is preserved before the terminal closes, so worker-read still returns output afterwards.',
      'Never closes setup terminals, configured tabs, reused or pre-existing terminals, user-taken-over terminals, or unproven identities.',
      'Idempotent: repeating the call reports already_released. Only release_unknown exits 1; retained, release_pending, and already_released exit 0.'
    ]
  },
  {
    path: ['orchestration', 'worker-retain'],
    summary: 'Keep one supervised worker terminal live for debugging',
    usage:
      'orca orchestration worker-retain --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    flagHelp: workerFlagHelp(),
    notes: [
      'Records a durable user-requested exception; a later explicit worker-release clears it and releases the terminal.',
      'A settled Dispatch created by orchestration dispatch has no owned terminal resource and is reported retained without process action.',
      'Performs no process or filesystem action.'
    ]
  },
  {
    path: ['orchestration', 'worker-list'],
    summary: 'List supervised worker terminal resource accounting',
    usage:
      'orca orchestration worker-list [--run <run_id>] [--terminal-state <active|reclaimable|retained|release_pending|release_unknown|released>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'terminal-state'],
    flagHelp: workerFlagHelp({
      'terminal-state':
        '<state> Filter by state: active, reclaimable, retained, release_pending, release_unknown, or released'
    }),
    notes: [
      'Terminal state is process accounting and is reported separately from Task status; a completed Task can still own a live terminal.',
      'Context-only Dispatches created by orchestration dispatch are included as unsupervised with terminal state retained.'
    ]
  }
]
