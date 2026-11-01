import {
  DEFAULT_SPAWN_ADMISSION_LIMITS,
  refill,
  userResumeTokensPerMs,
  type SpawnAdmissionLimits,
  type TokenBucket
} from '../../../../shared/host-spawn-admission'
import { PrioritySemaphore } from '../../../../shared/priority-semaphore'

export type UserResumeSpawnPacer = {
  /** Release the reservation after the spawn settles, including failure. */
  take(signal?: AbortSignal): Promise<() => void>
}

export function createUserResumeSpawnPacer(
  options: {
    limits?: SpawnAdmissionLimits
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {}
): UserResumeSpawnPacer {
  const limits = options.limits ?? DEFAULT_SPAWN_ADMISSION_LIMITS
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const tokensPerMs = userResumeTokensPerMs(limits)
  const capacity = Math.max(
    1,
    Math.min(limits.userResumeBucketCapacity - 1, limits.userResumeConcurrency)
  )
  const slots = new PrioritySemaphore(capacity)
  let bucket: TokenBucket = { tokens: capacity, updatedAt: now() }
  let reserved = 0
  let queue: Promise<void> = Promise.resolve()

  const current = (): TokenBucket => {
    bucket = refill(bucket, capacity, tokensPerMs, now())
    return bucket
  }

  return {
    take: async (signal) => {
      const releaseSlot = await slots.acquire(0, signal)
      try {
        const turn = queue.then(async () => {
          signal?.throwIfAborted()
          while (current().tokens - reserved < 1) {
            await sleep(Math.ceil((1 + reserved - bucket.tokens) / tokensPerMs))
            signal?.throwIfAborted()
          }
          reserved += 1
        })
        queue = turn.catch(() => {})
        await turn
      } catch (error) {
        releaseSlot()
        throw error
      }
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        // Debit on settlement so preparation and daemon waits cannot mint replacement tokens.
        bucket = { tokens: current().tokens - 1, updatedAt: bucket.updatedAt }
        reserved -= 1
        releaseSlot()
      }
    }
  }
}

export const userResumeSpawnPacer = createUserResumeSpawnPacer()
