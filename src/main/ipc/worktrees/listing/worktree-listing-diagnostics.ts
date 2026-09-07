import { shouldEmitBoundedWarning } from '../../bounded-warning-dedupe'

export const loggedUnavailableSshGitProviders = new Set<string>()
export const loggedWorktreeListFailures = new Set<string>()
export const loggedMalformedWorktreeMetaKeys = new Set<string>()

export function warnOnce(keySet: Set<string>, key: string, message: string, error?: unknown): void {
  if (!shouldEmitBoundedWarning(keySet, key)) {
    return
  }
  if (error) {
    console.warn(message, error)
  } else {
    console.warn(message)
  }
}

const SCAN_FAILURE_REASON_MAX_CHARS = 240

/**
 * The cause a retained-but-unscannable repo shows the user. The first two lines carry the
 * classifier's summary plus its `Wsl/Service/WSL_E_*` code; everything after is the raw command.
 */
export function describeWorktreeScanFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const summary = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2)
    .join(' ')
  const reason = summary.length > 0 ? summary : 'Worktree scan failed with no diagnostic.'
  return reason.length > SCAN_FAILURE_REASON_MAX_CHARS
    ? `${reason.slice(0, SCAN_FAILURE_REASON_MAX_CHARS - 1)}…`
    : reason
}
