import { assertProfileLifetimeAdmission } from './profile-lifetime-admission'

const pendingByTarget = new Map<string, Set<object>>()

/** Tracks local continuation settlement, never host execution or cancellation acknowledgment. */
export async function runSshProviderContinuation<T>(
  targetId: string,
  operation: () => Promise<T>
): Promise<T> {
  assertProfileLifetimeAdmission()
  const pending = pendingByTarget.get(targetId) ?? new Set<object>()
  const token = {}
  pendingByTarget.set(targetId, pending)
  pending.add(token)
  try {
    return await operation()
  } finally {
    pending.delete(token)
    if (pending.size === 0 && pendingByTarget.get(targetId) === pending) {
      pendingByTarget.delete(targetId)
    }
  }
}

export function hasSshProviderContinuations(targetId: string): boolean {
  return (pendingByTarget.get(targetId)?.size ?? 0) > 0
}
