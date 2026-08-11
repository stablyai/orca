/**
 * Failure diagnostics injected into the POSIX setup/issue-command runner.
 *
 * Why: the runner is unattended automation that reads no shell startup file, so a tool installed by
 * a version manager (mise, asdf, nvm, volta) can be absent here while it resolves in the user's own
 * terminal. The shell then reports only `command not found`, which names neither the PATH the hook
 * had nor the reason it differed. Print both on failure so the operator can act on the first run.
 */

const REPORT_FUNCTION_NAME = '__orca_report_runner_failure'
const EXIT_FUNCTION_NAME = '__orca_report_runner_exit'
const REPORTED_FLAG_NAME = '__orca_runner_failure_reported'

const REPORT_MISSING_COMMAND = [
  `printf 'Orca setup: that command is not on the PATH this script ran with:\\n%s\\n' "$PATH" >&2`,
  `printf 'Orca setup: this script runs without your interactive shell startup files, so a tool installed by a version manager (mise, asdf, nvm, volta) is found here only when its shim directory is on PATH.\\n' >&2`
].join('; ')

const REPORT_FUNCTION_BODY = [
  'local status=$1',
  'local failed_command=$2',
  `${REPORTED_FLAG_NAME}=1`,
  `printf 'Orca setup: command failed with status %s: %s\\n' "$status" "$failed_command" >&2`,
  `if [ "$status" = 127 ]; then ${REPORT_MISSING_COMMAND}; fi`
].join('; ')

// Why: the ERR trap is not inherited by functions, so a script that wraps its work in one would
// fail silently. `set -E` would inherit it but then reports a command substitution twice, once in
// the subshell and once in the parent. The EXIT fallback instead reports whatever the ERR trap
// missed, and the flag keeps every failure to a single report without errtrace.
const EXIT_FUNCTION_BODY = [
  'local status=$?',
  `if [ "$status" != 0 ] && [ -z "\${${REPORTED_FLAG_NAME}:-}" ]; then ${REPORT_FUNCTION_NAME} "$status" "$BASH_COMMAND"; fi`
].join('; ')

/**
 * Bash prelude that reports the failing command, its status, and — for status 127 — the PATH the
 * runner ran with. Kept to a single line so the shell's own `line N` errors still point at the
 * user's script line, and emitted before the script so its traps cover every line of it.
 *
 * Reports once per run and leaves the exit status untouched. Known limits: a script that installs
 * its own `EXIT` trap replaces the fallback (top-level failures still report through `ERR`), and
 * bash 3.2 names the trap rather than the command when a bare subshell is the only thing that
 * fails.
 */
export function getPosixRunnerFailureReportPrelude(): string {
  return [
    `${REPORT_FUNCTION_NAME}() { ${REPORT_FUNCTION_BODY}; }`,
    `trap '${REPORT_FUNCTION_NAME} "$?" "$BASH_COMMAND"' ERR`,
    `${EXIT_FUNCTION_NAME}() { ${EXIT_FUNCTION_BODY}; }`,
    `trap ${EXIT_FUNCTION_NAME} EXIT\n`
  ].join('; ')
}
