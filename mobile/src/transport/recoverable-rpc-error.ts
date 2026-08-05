const RECOVERABLE_RPC_ERROR_KIND = 'recoverable-rpc' as const

export class RecoverableRpcError extends Error {
  readonly rpcErrorKind = RECOVERABLE_RPC_ERROR_KIND

  constructor(message: string) {
    super(message)
    this.name = 'RecoverableRpcError'
  }
}

export function isRecoverableRpcError(error: unknown): error is RecoverableRpcError {
  return (
    error instanceof Error &&
    (error as { rpcErrorKind?: unknown }).rpcErrorKind === RECOVERABLE_RPC_ERROR_KIND
  )
}
