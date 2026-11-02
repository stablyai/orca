function isTransientWorkerTerminalCloseError(reason: string): boolean {
  return /not connected|unavailable/i.test(reason)
}

/** After host-certified exit, nothing-left-to-close is success; retrying the same absent target adds no evidence. */
function isMissingWorkerTerminalCloseError(reason: string): boolean {
  return /handle_stale|stale handle|not found|no such terminal/i.test(reason)
}

/** Disposed endpoints are both absent and reconnectable; host observation decides, so do not model these as disjoint predicates. */
function isDisposedWorkerTerminalCloseError(reason: string): boolean {
  return /disposed/i.test(reason)
}

export function classifyWorkerTerminalCloseError(error: unknown): {
  reason: string
  transient: boolean
  alreadyGone: boolean
} {
  const reason = error instanceof Error ? error.message : String(error)
  const disposed = isDisposedWorkerTerminalCloseError(reason)
  return {
    reason,
    transient: disposed || isTransientWorkerTerminalCloseError(reason),
    alreadyGone: disposed || isMissingWorkerTerminalCloseError(reason)
  }
}

export const TRANSIENT_WORKER_RELEASE_RECOVERY =
  'The owning endpoint is temporarily unavailable; recovery will retry this release after reconnect without another coordinator decision.'
