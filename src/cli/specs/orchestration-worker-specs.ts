import { GLOBAL_FLAGS, type CommandSpec } from '../args'

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
    notes: [
      'Current and existing worktrees never rerun setup; a fresh agent terminal is created unless --terminal is explicit.',
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
    path: ['orchestration', 'worker-supervise'],
    summary: 'Run a Codex worker with ordered account failover until completion or attention',
    usage:
      'orca orchestration worker-supervise --task <task_id> [--accounts <id|email|label|#number,...>] [worker-start flags] [--wait-timeout-ms <n>] [--poll-ms <n>] [--retry-start-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'accounts',
      'on',
      'worktree',
      'name',
      'repo',
      'base-branch',
      'display-name',
      'comment',
      'setup',
      'model',
      'effort',
      'timeout-ms',
      'wait-timeout-ms',
      'poll-ms',
      'retry-start-request',
      'retry-start-retry-of',
      'run',
      'from'
    ],
    notes: [
      'Uses Codex managed accounts only. Without --accounts, unique numbered labels are tried from highest to lowest (#3, #2, #1).',
      'A lost start reply prints an exact recovery command (remaining --accounts, --retry-start-request <id>, and --retry-start-retry-of <dispatch> when a lineage exists) that replays the byte-identical start mutation without spawning a second Dispatch. Definite runtime errors are reported as start_failed instead and must not be replayed blindly.',
      'Managed account selection is local to one Orca runtime, so --on is rejected. Run this command on the worker server instead.',
      'A provider-authored usage-limit message fences and releases that exact attempt, then creates a new Dispatch linked by retryOf under the next account.',
      'Questions and escalations stop the loop for coordinator attention. worker_done returns awaiting_acceptance; it does not auto-accept the result.',
      'Every attempt records its account and Dispatch. No credentials are copied and no worktree is deleted.'
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
    summary: 'Read bounded output from one supervised worker',
    usage:
      'orca orchestration worker-read --dispatch <dispatch_id> [--source <auto|transcript|terminal>] [--cursor <cursor>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'source', 'cursor', 'limit'],
    notes: [
      'The default auto source uses an exact hook-reported transcript when available and otherwise returns labeled terminal output.',
      'A returned cursor is pinned to the exact source; start a fresh read if Orca reports source_changed.'
    ]
  },
  {
    path: ['orchestration', 'worker-stop'],
    summary: 'Fence one Dispatch and stop its supervised agent terminal',
    usage:
      'orca orchestration worker-stop --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
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
    notes: ['Retains all possibly-live resources and performs no process or filesystem action.']
  },
  {
    path: ['orchestration', 'worker-release'],
    summary: 'Release the terminal of one settled supervised worker',
    usage:
      'orca orchestration worker-release --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    notes: [
      'Post-completion cleanup for a settled (succeeded or failed) worker; closes only the exact coordinator-owned agent terminal of that worker.',
      'An inspectable output archive is preserved before the terminal closes, so worker-read still returns output afterwards.',
      'Never closes setup terminals, configured tabs, reused or pre-existing terminals, user-taken-over terminals, or unproven identities.',
      'Idempotent: repeating the call reports already_released. release_unknown and release_pending exit 1 (a recovery obligation remains); retained and already_released exit 0.'
    ]
  },
  {
    path: ['orchestration', 'worker-accept'],
    summary: 'Write a durable coordinator acceptance receipt and release a settled worker terminal',
    usage:
      'orca orchestration worker-accept --dispatch <dispatch_id> --evidence <text> [--from <handle>] [--retry-release-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'dispatch',
      'evidence',
      'from',
      'retry-request',
      'retry-release-request'
    ],
    notes: [
      'Requires a succeeded worker_done settlement. Acceptance is a separate durable coordinator decision.',
      'Checks the exact worktree through git.status. Dirty, in-progress-operation, truncated, or unpushed status is retained as not closeable; the acceptance receipt records the worktree HEAD SHA.',
      'The acceptance receipt mutation id is derived from the dispatch, so every invocation (first run or crash-recovery rerun) hits the same ledger receipt instead of duplicating it; a rerun with different evidence or changed worktree state fails closed as request_mismatch. Pass the reported release id back through --retry-release-request (--retry-request stays a legacy alias).',
      'Only released/already_released report accepted with exit 0; release_pending and release_unknown exit 1 with the recovery obligation preserved.',
      'Archives and releases only the exact worker terminal after the receipt is written. The worktree is never deleted.'
    ]
  },
  {
    path: ['orchestration', 'worker-retain'],
    summary: 'Keep one supervised worker terminal live for debugging',
    usage:
      'orca orchestration worker-retain --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    notes: [
      'Records a durable user-requested exception; a later explicit worker-release clears it and releases the terminal.',
      'Performs no process or filesystem action.'
    ]
  },
  {
    path: ['orchestration', 'worker-list'],
    summary: 'List supervised worker terminal resource accounting',
    usage:
      'orca orchestration worker-list [--run <run_id>] [--terminal-state <active|reclaimable|retained|release_pending|release_unknown|released>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'terminal-state'],
    notes: [
      'Terminal state is process accounting and is reported separately from Task status; a completed Task can still own a live terminal.'
    ]
  }
]
