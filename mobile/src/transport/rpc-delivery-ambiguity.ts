// Why: RPCs are at-most-once — a socket drop or response timeout after the
// request frame was written leaves delivery unknown (the host may have processed
// it and only the ack was lost), unlike a failure before the frame ever left.
const deliveryUnknownErrors = new WeakSet<Error>()

export function markRpcDeliveryUnknown<T extends Error>(error: T): T {
  deliveryUnknownErrors.add(error)
  return error
}

/** True when the request reached the wire but the RPC failed before a response
 *  arrived — callers must not present this as a definite send failure. */
export function isRpcDeliveryUnknown(error: unknown): boolean {
  return error instanceof Error && deliveryUnknownErrors.has(error)
}
