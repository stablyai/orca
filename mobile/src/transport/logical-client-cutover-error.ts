// The error a pending RPC is rejected with when the logical client swaps physical sessions
// mid-flight. Its own module so every caller that retries on a cutover can import it without
// pulling in the client itself — several of them are imported BY the client.

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
