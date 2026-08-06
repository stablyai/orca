export function decrementPendingAcquisition(pending: Map<string, number>, hostId: string): number {
  const next = Math.max(0, (pending.get(hostId) ?? 0) - 1)
  if (next === 0) {
    pending.delete(hostId)
  } else {
    pending.set(hostId, next)
  }
  return next
}
