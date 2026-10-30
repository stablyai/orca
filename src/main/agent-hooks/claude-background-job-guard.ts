// Claude daemon workers, and the agents they spawn (e.g. `codex exec`), inherit the
// dispatching pane's ORCA_* env, so their pane key names a pane they do not run in (#9236, #24516).
// Windows exits before owning stdin: the caller may abandon it, and draining would hang (#11549).
export const WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD = 'if not "%CLAUDE_JOB_DIR%"=="" exit /b 0'

// POSIX callers must capture stdin first so the agent never sees EPIPE.
export function buildPosixClaudeBackgroundJobGuardLines(): string[] {
  return ['if [ -n "$CLAUDE_JOB_DIR" ]; then', '  exit 0', 'fi']
}
