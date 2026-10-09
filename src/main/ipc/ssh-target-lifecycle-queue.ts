// Serializes disconnect/remove/terminate/reset for a single SSH target so they cannot interleave.
export const targetLifecycleInFlight = new Map<string, Promise<void>>()

export function runTargetLifecycle<T>(targetId: string, operation: () => Promise<T>): Promise<T> {
  const prior = targetLifecycleInFlight.get(targetId)
  const operationPromise = (async () => {
    if (prior) {
      await prior.catch(() => undefined)
    }
    return operation()
  })()
  let trackedPromise!: Promise<void>
  trackedPromise = operationPromise
    .then(
      () => undefined,
      () => undefined
    )
    .finally(() => {
      if (targetLifecycleInFlight.get(targetId) === trackedPromise) {
        targetLifecycleInFlight.delete(targetId)
      }
    })
  targetLifecycleInFlight.set(targetId, trackedPromise)
  return operationPromise
}

export async function awaitTargetLifecycle(targetId: string): Promise<void> {
  while (true) {
    const lifecycle = targetLifecycleInFlight.get(targetId)
    if (!lifecycle) {
      return
    }
    await lifecycle.catch(() => undefined)
  }
}
