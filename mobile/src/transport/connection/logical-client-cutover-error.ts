import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from '../rpc/rpc-delivery-ambiguity'

export class LogicalClientCutoverError extends Error {
  constructor(cause?: unknown) {
    super('RPC interrupted by connection migration', { cause })
    if (isRpcDeliveryUnknown(cause)) {
      markRpcDeliveryUnknown(this)
    }
  }
}

// Why: instanceof can miss across bundle copies, so also match by message.
export function isLogicalClientCutoverError(error: unknown): boolean {
  return (
    error instanceof LogicalClientCutoverError ||
    (error instanceof Error && error.message === 'RPC interrupted by connection migration')
  )
}
