// Claude daemon workers and CodeBuddy background sessions, and the agents they
// spawn, inherit the dispatching pane's ORCA_* env, so their pane key names a
// pane they do not run in (#9236, #24516, #41084). CodeBuddy documents
// CODEBUDDY_SESSION_KIND=bg for `codebuddy --bg`; CODEBUDDY_JOB_DIR is the
// same kind of marker as CLAUDE_JOB_DIR. Interactive sessions use kind
// "interactive" and must still report.
// Windows exits before owning stdin: the caller may abandon it, and draining would hang (#11549).
export const WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD = [
  'if not "%CLAUDE_JOB_DIR%"=="" exit /b 0',
  'if /i "%CODEBUDDY_SESSION_KIND%"=="bg" exit /b 0',
  'if not "%CODEBUDDY_JOB_DIR%"=="" exit /b 0'
].join('\r\n')

// POSIX callers must capture stdin first so the agent never sees EPIPE.
export function buildPosixClaudeBackgroundJobGuardLines(): string[] {
  return [
    'if [ -n "$CLAUDE_JOB_DIR" ] || [ "$CODEBUDDY_SESSION_KIND" = "bg" ] || [ -n "$CODEBUDDY_JOB_DIR" ]; then',
    '  exit 0',
    'fi'
  ]
}
