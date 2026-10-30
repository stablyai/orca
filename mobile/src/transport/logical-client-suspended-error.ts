// A suspended client refuses before anything is written, while recovery dials a replacement.
export class LogicalClientSuspendedError extends Error {
  constructor() {
    super('Client suspended')
  }
}

// Why: errors crossing the page bridge are rebuilt as other classes, so also match by message.
export function isLogicalClientSuspendedError(error: unknown): boolean {
  return (
    error instanceof LogicalClientSuspendedError ||
    (error instanceof Error && error.message === 'Client suspended')
  )
}
