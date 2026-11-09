import { cliErrorCode } from './cli-error'
import { RuntimeClientError } from './runtime/types'

const PLUGIN_EXIT_CODES: Readonly<Record<string, number>> = {
  plugin_invalid: 2,
  approval_required: 3,
  approval_stale: 3
}

// Errors from a provider create; plain `worktree create` keeps exit 1 for everything it did before.
const providerCreateErrors = new WeakSet<object>()

/** Tag an error from `worktree create --on <provider>` so it gets the provider exit codes. */
export function markProviderCreateError<T>(error: T): T {
  if (typeof error === 'object' && error !== null) {
    providerCreateErrors.add(error)
  }
  return error
}

/** Provider commands: 2 invalid input, 3 confirm, 4 created but a follow-up failed, 5 a host may still run. */
function providerExitCode(error: unknown, code: string | undefined): number {
  if (code === 'invalid_argument') {
    return 2
  }
  if (code === 'confirmation_required') {
    return 3
  }
  if (code === 'workspace_follow_up_failed') {
    return 4
  }
  if (code === 'host_create_failed' && error instanceof RuntimeClientError) {
    const data = error.data
    const state =
      typeof data === 'object' &&
      data !== null &&
      'host' in data &&
      typeof data.host === 'object' &&
      data.host !== null &&
      'state' in data.host
        ? data.host.state
        : undefined
    return state === 'destroy-failed' || state === 'left-running' || state === 'unknown' ? 5 : 1
  }
  return 1
}

/** `orca plugin` and provider-command exit codes are a stable contract so scripts can tell "invalid", "ask a human" and "something may still be running" apart from failure. */
export function cliErrorExitCode(error: unknown, commandPath: readonly string[]): number {
  const code = cliErrorCode(error)
  if (commandPath[0] === 'plugin') {
    return code ? (PLUGIN_EXIT_CODES[code] ?? 1) : 1
  }
  const isProviderCommand =
    commandPath[0] === 'provider' ||
    (typeof error === 'object' && error !== null && providerCreateErrors.has(error))
  return isProviderCommand ? providerExitCode(error, code) : 1
}
