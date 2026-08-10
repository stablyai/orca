/**
 * Failure diagnostics injected into the POSIX setup/issue-command runner.
 *
 * Why: the runner is unattended automation that reads no shell startup file, so a tool installed by
 * a version manager (mise, asdf, nvm, volta) can be absent here while it resolves in the user's own
 * terminal. The shell then reports only `command not found`, which names neither the PATH the hook
 * had nor the reason it differed. Print both on failure so the operator can act on the first run.
 */

const REPORT_FUNCTION_NAME = '__orca_report_runner_failure'

const REPORT_MISSING_COMMAND = [
  `printf 'Orca setup: that command is not on the PATH this script ran with:\\n%s\\n' "$PATH" >&2`,
  `printf 'Orca setup: this script runs without your interactive shell startup files, so a tool installed by a version manager (mise, asdf, nvm, volta) is found here only when its shim directory is on PATH.\\n' >&2`
].join('; ')

const REPORT_FUNCTION_BODY = [
  'local status=$1',
  'local failed_command=$2',
  `printf 'Orca setup: command failed with status %s: %s\\n' "$status" "$failed_command" >&2`,
  `if [ "$status" = 127 ]; then ${REPORT_MISSING_COMMAND}; fi`
].join('; ')

/**
 * Bash prelude that reports the failing command, its status, and — for status 127 — the PATH the
 * runner ran with. Kept to a single line so the shell's own `line N` errors still point at the
 * user's script line, and emitted before the script so its `ERR` trap covers every line of it.
 */
export function getPosixRunnerFailureReportPrelude(): string {
  return `${REPORT_FUNCTION_NAME}() { ${REPORT_FUNCTION_BODY}; }; trap '${REPORT_FUNCTION_NAME} "$?" "$BASH_COMMAND"' ERR\n`
}
