import { GLOBAL_FLAGS, type CommandSpec } from '../args'
import { orchestrationFlagHelp } from './orchestration-flag-help'

export const ORCHESTRATION_WORKER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'worker-start'],
    summary: 'Start one supervised worker on the Run home or a connected Orca server',
    usage:
      'orca orchestration worker-start (--task <task_id> | --spec <text>) [--on <saved-environment>] [--worktree <current|selector|new-child|new-top-level>] (--agent <agent> | --terminal <handle>) [--task-title <text>] [--deps <json_array>] [--parent <task_id>] [--model <id>] [--effort <level>] [--name <name>] [--repo <selector>] [--base-branch <ref>] [--display-name <text>] [--comment <text>] [--setup <run|skip|inherit>] [--retry-of <dispatch_id>] [--timeout-ms <n>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'spec',
      'task-title',
      'deps',
      'parent',
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
    flagHelp: orchestrationFlagHelp({
      task: '<task_id> Existing task to assign to the worker',
      spec: '<text> Instructions for a new task created with the worker',
      'task-title': '<text> Concise title for the task created from --spec',
      deps: '<json_array> Prerequisite task ids for the task created from --spec',
      parent: '<task_id> Parent of the task created from --spec',
      on: '<saved-environment> Saved environment whose Orca server runs the worker',
      worktree: '<placement> current, an existing worktree selector, new-child, or new-top-level',
      name: '<name> Name for a new worktree',
      repo: '<selector> Repository for a new worktree on the worker server',
      'base-branch': '<ref> Base ref for a new worktree',
      'display-name': '<text> Display name for a new worktree',
      comment: '<text> Comment for a new worktree',
      setup: '<run|skip|inherit> Setup policy for a new worktree (default run)',
      agent: '<agent> Orca agent id to launch in a fresh terminal',
      model: '<id> Provider model id for the fresh agent',
      effort: '<level> Reasoning effort for --model',
      terminal: '<handle> Existing agent terminal to reuse instead of launching one',
      'retry-of': '<dispatch_id> Prior Dispatch this attempt replaces; needs --task',
      'timeout-ms': '<n> Maximum time to wait for the worker to become ready'
    }),
    identityFlagRoles: { from: 'caller', terminal: 'target' },
    notes: [
      'Current and existing worktrees never rerun setup; a fresh agent terminal is created unless --terminal is explicit.',
      'When reusing --terminal, pass --worktree for that terminal; current means the coordinator worktree.',
      '--agent takes an Orca agent id enabled on the worker server, such as claude, codex, cursor, antigravity, muse, zcode, opencode, or opencode2.',
      '--model supports Claude, Codex, Cursor, Antigravity, and Muse opaque provider model ids; --effort requires --model. OMP accepts --model only; --effort is unsupported. Neither can combine with --terminal. OpenCode model selection requires an existing worktree, a verified execution-host CLI, and an available model; effort is unsupported. Other agents, including zcode, launch with the model from their own config.',
      'New worktrees use agent-first creation and default --setup to run. Repository start-immediately runs setup beside the agent; wait-for-setup gates agent readiness and task input.',
      'Creation flags (--name, --repo, --base-branch, --display-name, --comment, --setup) are rejected for current/existing worktrees. Use exact --repo on the selected server; project/host convenience routing remains on worktree create.',
      "How the worker runs follows the user's own setting for new agent tabs; there is no flag for it and no caller needs to ask. A dispatch the setting cannot apply to still starts, so the placement, agent, and launch options passed here are always the ones honoured.",
      'Drive every worker the same way whichever way it was started: the same orchestration verbs, the same handle. Mail, dispatch, worker-show, worker-read and the whole lifecycle behave identically. The start receipt records which one ran, for operators and telemetry.',
      'Not every worker has a terminal. Read output with worker-read --source auto or --source transcript, which always work; --source terminal is refused when there is none, and orca terminal verbs do not accept every worker handle. Nothing above needs you to know which kind you have — the orchestration verbs cover all of them.',
      '--on selects only the worker server; the Run and this command remain on the current Orca server.',
      'Remote current and new-child are invalid; discover an exact remote selector or use new-top-level.',
      '--retry-of needs --task naming the failed Task (--spec creates a new one) and does not inherit placement; repeat the intended --on/worktree and --agent/terminal choices.',
      'The call exits 0 only for ready. Failed or outcome_unknown exits 1 and JSON includes stage/failedStage, setup, effects, residualResources, and recovery commands when needed.'
    ]
  },
  {
    path: ['orchestration', 'worker-show'],
    summary: 'Inspect one supervised worker Dispatch',
    usage: 'orca orchestration worker-show --dispatch <dispatch_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch'],
    flagHelp: orchestrationFlagHelp({
      dispatch: '<dispatch_id> Worker Dispatch to inspect'
    }),
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
    flagHelp: orchestrationFlagHelp({
      dispatch: '<dispatch_id> Worker Dispatch to read',
      source: '<auto|transcript|terminal> Output source (default auto)',
      cursor: '<cursor> Opaque cursor returned by a previous worker-read page',
      limit: '<n> Maximum transcript messages or terminal lines to return'
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
    flagHelp: orchestrationFlagHelp({
      dispatch: '<dispatch_id> Worker Dispatch to fence and stop'
    }),
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
    flagHelp: orchestrationFlagHelp({
      dispatch: '<dispatch_id> Worker Dispatch to fence'
    }),
    notes: ['Retains all possibly-live resources and performs no process or filesystem action.']
  },
  {
    path: ['orchestration', 'worker-release'],
    summary: 'Release the terminal of one settled supervised worker',
    usage:
      'orca orchestration worker-release --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    flagHelp: orchestrationFlagHelp({
      dispatch: '<dispatch_id> Settled worker Dispatch whose terminal to release'
    }),
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
    flagHelp: orchestrationFlagHelp({
      dispatch: '<dispatch_id> Worker Dispatch whose terminal to keep live'
    }),
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
      'orca orchestration worker-list [--run <run_id>] [--terminal-state <active|reclaimable|retained|release_pending|release_unknown|released>] [--include-remote] [--cursor <cursor>] [--limit <1-100>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'terminal-state', 'include-remote', 'cursor', 'limit'],
    flagHelp: orchestrationFlagHelp({
      run: '<run_id> Only this Run; defaults to the bound Run, or every Run when unbound',
      'terminal-state':
        '<state> Terminal accounting filter: active, reclaimable, retained, release_pending, release_unknown, or released',
      'include-remote': 'Include connected-server worker observations',
      cursor: '<cursor> Opaque page cursor copied from page.nextCursor',
      limit: '<1-100> Maximum number of rows per page (default 100)'
    }),
    notes: [
      'Terminal state is process accounting and is reported separately from Task status; a completed Task can still own a live terminal.',
      'Context-only Dispatches created by orchestration dispatch are included as unsupervised with terminal state retained.',
      'Returns at most 100 local rows, newest first, by default; --include-remote adds connected-server observations when the host supports fleet listing. Continue with the opaque page.nextCursor value unchanged.',
      'Without --run the list is scoped to the Run bound to the calling terminal, and to every Run when there is no binding; the receipt reports which in scope.source (flag, bound, or all).'
    ]
  }
]
