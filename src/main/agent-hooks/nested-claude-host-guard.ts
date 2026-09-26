import { WINDOWS_HOOK_STDIN_DRAIN_LABEL } from './hook-stdin-contract'

// The variables Claude Code exports into every process it launches. A nested
// agent inherits them along with the lead pane's ORCA_PANE_KEY.
const NESTED_CLAUDE_TURN_VARS = ['CLAUDECODE', 'CLAUDE_CODE'] as const

// Why: a backgrounded Claude job runs in a daemon worker outside any pane, and
// that worker may abandon stdin. On Windows the drain parks in more.com, so
// this marker must exit instead of routing there (#11549) — the same rule
// `claude/hook-script.ts` and `claude/statusline-script.ts` already follow.
const NESTED_CLAUDE_WORKER_VAR = 'CLAUDE_JOB_DIR'

const NESTED_CLAUDE_HOST_VARS = [...NESTED_CLAUDE_TURN_VARS, NESTED_CLAUDE_WORKER_VAR] as const

/**
 * Why (#20109): an agent launched from inside a Claude Code turn inherits the
 * lead pane's `ORCA_PANE_KEY`, so its own `Stop`/`SessionEnd` settles the lead's
 * pane and fires Agent Task Complete while the lead is still working. Only the
 * lead session on a pane may settle it. Claude's own hook already bails the same
 * way on `CLAUDE_JOB_DIR` (#9236); this is the cross-agent case.
 *
 * The guard has to live in the managed template, because `refreshManagedScripts`
 * rewrites the installed script from it on every launch.
 */
export function buildPosixNestedClaudeHostGuardLines(): string[] {
  const condition = NESTED_CLAUDE_HOST_VARS.map((name) => `[ -n "$${name}" ]`).join(' || ')
  return [`if ${condition}; then`, '  exit 0', 'fi']
}

/** The same guard for a cmd hook. A nested turn still owns a live pipe, so it
 *  routes to the drain; the daemon-worker marker exits without draining. */
export function buildWindowsNestedClaudeHostGuardLines(): string[] {
  return [
    `if not "%${NESTED_CLAUDE_WORKER_VAR}%"=="" exit /b 0`,
    ...NESTED_CLAUDE_TURN_VARS.map(
      (name) => `if not "%${name}%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`
    )
  ]
}
