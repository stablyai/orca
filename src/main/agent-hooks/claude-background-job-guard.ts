// Why: a backgrounded Claude session runs in a daemon worker that inherited the dispatching
// pane's env, so ORCA_PANE_KEY names a pane this session does not run in (#9236).
// Why exit, not the drain label: the drain parks in more.com and a worker is outside
// an Orca pane — the abandoned-stdin hang #11549 guards against.
export const WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD = 'if not "%CLAUDE_JOB_DIR%"=="" exit /b 0'

export function buildPosixClaudeBackgroundJobGuardLines(): string[] {
  return ['if [ -n "$CLAUDE_JOB_DIR" ]; then', '  exit 0', 'fi']
}

export function buildWindowsClaudeBackgroundJobGuardLines(): string[] {
  return [WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD]
}
