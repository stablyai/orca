import { cliErrorCode } from './cli-error'

const PLUGIN_EXIT_CODES: Readonly<Record<string, number>> = {
  plugin_invalid: 2,
  approval_required: 3,
  approval_stale: 3
}

/** `orca plugin` exit codes are a stable contract so scripts can tell "invalid" and "ask a human" apart from failure. */
export function cliErrorExitCode(error: unknown, commandPath: readonly string[]): number {
  const code = cliErrorCode(error)
  return commandPath[0] === 'plugin' && code ? (PLUGIN_EXIT_CODES[code] ?? 1) : 1
}
