/** Raised when a connection migration replaced the session a logical request belonged to. */
export class LogicalClientCutoverError extends Error {
  constructor() {
    super('RPC interrupted by connection migration')
  }
}

// Why: instanceof can miss across bundle copies, so also match by message.
export function isLogicalClientCutoverError(error: unknown): boolean {
  return (
    error instanceof LogicalClientCutoverError ||
    (error instanceof Error && error.message === 'RPC interrupted by connection migration')
  )
}
