import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { readUntrustedBoolean, readUntrustedExitCode } from '../../shared/untrusted-value-fields'
import { buildWslGuestObservationPrelude } from './wsl-guest-filesystem-observation'
import {
  MARKER_NOT_REGULAR_FILE_MESSAGE,
  MISSING_OWNERSHIP_MARKER_MESSAGE
} from './host-codex-managed-home-ownership'
import { MARKER_ACCOUNT_MISMATCH_MESSAGE } from './wsl-codex-managed-home-probe'

/**
 * Re-auth creates the managed home in the guest before the read probe gates it.
 * It runs as a separate script because it *writes*, and the exit codes below are
 * the only ones that may be read as a trust verdict — every other status is a
 * failure to determine, which the host maps to indeterminate (STA-5616).
 */
export const WSL_PREPARE_MARKER_MISSING_EXIT = 41
export const WSL_PREPARE_MARKER_MISMATCH_EXIT = 42
export const WSL_PREPARE_MARKER_NOT_REGULAR_EXIT = 43
/** Reserved so the guest can say "I could not tell" instead of guessing. */
export const WSL_PREPARE_INDETERMINATE_EXIT = 44

export const WSL_PREPARE_UNTRUSTED_EXITS = new Map<number, string>([
  [WSL_PREPARE_MARKER_MISSING_EXIT, MISSING_OWNERSHIP_MARKER_MESSAGE],
  [WSL_PREPARE_MARKER_MISMATCH_EXIT, MARKER_ACCOUNT_MISMATCH_MESSAGE],
  [WSL_PREPARE_MARKER_NOT_REGULAR_EXIT, MARKER_NOT_REGULAR_FILE_MESSAGE]
])

/**
 * Every observation goes through `kind_of`, and every read is status-checked, so
 * a failure can only reach `WSL_PREPARE_INDETERMINATE_EXIT`. Exits 41/42/43 are
 * reachable only from a successful read — re-auth refuses on them, so a failed
 * observation arriving there would lock a user out of their own account.
 */
export function buildWslManagedHomePreparationScript(
  linuxPath: string,
  expectedAccountId: string
): string {
  return [
    'set -euo pipefail',
    ...buildWslGuestObservationPrelude(WSL_PREPARE_INDETERMINATE_EXIT),
    `candidate=${quotePosixShell(linuxPath)}`,
    `expected_marker=${quotePosixShell(expectedAccountId)}`,
    'marker="$candidate/.orca-managed-home"',
    // `-e` is trusted only when it says yes. Its "no" is not turned into a
    // verdict: it falls through to `mkdir -p`, and under `set -e` a home that
    // could not be created fails the script into the indeterminate lane.
    'if [ -e "$candidate" ]; then',
    '  kind_of "$marker" "$candidate" .orca-managed-home',
    '  case "$KIND" in',
    `    absent) exit ${WSL_PREPARE_MARKER_MISSING_EXIT} ;;`,
    '    regular) ;;',
    // Writing through a symlink would put the account id into whatever the link
    // points at, before any ownership check has run.
    `    *) exit ${WSL_PREPARE_MARKER_NOT_REGULAR_EXIT} ;;`,
    '  esac',
    '  contents=$(cat -- "$marker") || unknown',
    `  if [ "$contents" != "$expected_marker" ]; then exit ${WSL_PREPARE_MARKER_MISMATCH_EXIT}; fi`,
    'fi',
    'mkdir -p -- "$candidate"',
    `printf '%s\\n' "$expected_marker" > "$marker"`
  ].join('\n')
}

/**
 * Turns whatever the runner resolved into a verdict. Split out so the shape
 * check lives beside the exit-code table rather than in the caller, where an
 * unvalidated `result.timedOut` used to throw straight past the fail-closed path.
 */
export type WslPreparationOutcome =
  | { kind: 'prepared' }
  | { kind: 'untrusted'; reason: string }
  | { kind: 'indeterminate'; reason: string }

export function interpretWslPreparationResult(
  result: unknown,
  distro: string
): WslPreparationOutcome {
  const timedOut = readUntrustedBoolean(result, 'timedOut')
  if (timedOut === undefined) {
    return {
      kind: 'indeterminate',
      reason: `Preparing the managed Codex home in WSL ${distro} returned an unreadable result.`
    }
  }
  if (timedOut) {
    return {
      kind: 'indeterminate',
      reason: `Preparing the managed Codex home in WSL ${distro} timed out.`
    }
  }
  const code = readUntrustedExitCode(result, 'code')
  if (code === undefined || code === null) {
    return {
      kind: 'indeterminate',
      reason: `Preparing the managed Codex home in WSL ${distro} reported no exit code.`
    }
  }
  const untrustedReason = WSL_PREPARE_UNTRUSTED_EXITS.get(code)
  if (untrustedReason !== undefined) {
    return { kind: 'untrusted', reason: untrustedReason }
  }
  return code === 0
    ? { kind: 'prepared' }
    : {
        kind: 'indeterminate',
        reason: `Preparing the managed Codex home in WSL ${distro} exited with code ${String(code)}.`
      }
}
