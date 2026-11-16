import { shouldEmitBoundedWarning } from '../../bounded-warning-dedupe'

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

/** Keep the summary and WSL service code, omitting trailing raw command output. */
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
