function isTransientWorkerTerminalCloseError(reason: string): boolean {
  return /not connected|unavailable/i.test(reason)
}

/** The close found nothing to close. Against a host-certified exit that is the goal state, not new
 *  doubt: a retry only aims the same dead handle at the same absent terminal, forever. */
function isMissingWorkerTerminalCloseError(reason: string): boolean {
  return /handle_stale|stale handle|not found|no such terminal/i.test(reason)
}

/** A disposed endpoint is genuinely both: nothing is left to close, and it may return on
 *  reconnect. Only the host observation can say which, so it is named once here instead of
 *  being spelled into two predicates that then read as if they were disjoint. */
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
