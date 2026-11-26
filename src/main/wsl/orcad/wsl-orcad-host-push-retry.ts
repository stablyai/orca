/** Desktop-to-WSL-host pushes: serialized per host, retried until a newer push for that host supersedes it. */
import { runKeyedSerializedOperation } from '../../../shared/concurrency/keyed-serialized-operations'

/** A failed push is retried, since the host otherwise keeps the old value until it reconnects. */
export const WSL_HOST_PUSH_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const

export type WslOrcadHostPushQueue = {
  pending: Map<string, Promise<void>>
  generations: Map<string, number>
}

export function createWslOrcadHostPushQueue(): WslOrcadHostPushQueue {
  return { pending: new Map(), generations: new Map() }
}

/** Serialized per host, so an older push can never land after a newer one. */
export function pushToWslOrcadHostWithRetry(
  queue: WslOrcadHostPushQueue,
  environmentId: string,
  pushOnce: () => Promise<void>,
  onFailure: (error: unknown) => void,
  retryDelaysMs: readonly number[] = WSL_HOST_PUSH_RETRY_DELAYS_MS
): Promise<void> {
  const generation = (queue.generations.get(environmentId) ?? 0) + 1
  queue.generations.set(environmentId, generation)
  const attempt = (index: number): Promise<void> =>
    runKeyedSerializedOperation(queue.pending, environmentId, pushOnce).catch((error: unknown) => {
      onFailure(error)
      const delay = retryDelaysMs[index]
      if (delay === undefined) {
        return
      }
      const timer = setTimeout(() => {
        // A newer push already carries the current value.
        if (queue.generations.get(environmentId) === generation) {
          void attempt(index + 1)
        }
      }, delay)
      timer.unref?.()
    })
  return attempt(0)
}
