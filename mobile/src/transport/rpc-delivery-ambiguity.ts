// After a request reaches the wire, a lost reply leaves execution unknown and must not authorize a retry.
const deliveryUnknownErrors = new WeakSet<Error>()

export function markRpcDeliveryUnknown<T extends Error>(error: T): T {
  deliveryUnknownErrors.add(error)
  return error
}

// A written request without a reply must not be presented as a definite send failure.
export function isRpcDeliveryUnknown(error: unknown): boolean {
  return error instanceof Error && deliveryUnknownErrors.has(error)
}
