/**
 * The bash line an Orca CLI launcher or shim runs to name itself as the entry the caller invoked.
 * The outermost Orca script wins, so a shim that execs a launcher keeps the shim's own path; the CLI
 * compares it with the session's `ORCA_CLI_COMMAND` and consumes it (src/cli/session-cli-reexec.ts).
 * Kept identical to the line in the packaged launchers under resources/.
 */
export const ORCA_CLI_SELF_EXPORT = 'export ORCA_CLI_SELF="${ORCA_CLI_SELF:-${BASH_SOURCE[0]}}"\n'
