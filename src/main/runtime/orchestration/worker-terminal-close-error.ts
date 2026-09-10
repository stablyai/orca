function isTransientWorkerTerminalCloseError(reason: string): boolean {
  return /not connected|unavailable/i.test(reason)
}

function isMissingWorkerTerminalCloseError(reason: string): boolean {
  return /handle_stale|stale handle|not found|no such terminal/i.test(reason)
}

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
