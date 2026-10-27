// Why: the daemon defers a user resume only after this client's bucket is empty, when it is charged as automatic.
// A replacement that waits here for a token is never deferred after main stopped the old PTY (#34419).

import {
  DEFAULT_SPAWN_ADMISSION_LIMITS,
  refill,
  userResumeTokensPerMs,
  type SpawnAdmissionLimits,
  type TokenBucket
} from '../../../../shared/host-spawn-admission'

export type UserResumeSpawnPacer = {
  /** Waits until the daemon's bucket holds a user-resume token, then spends it. */
  take(): Promise<void>
  /** Spends a token for an unpaced user resume, as the daemon does, when one is left. */
  note(): void
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
  // Why one short of the daemon: a spawn the user-resume concurrency limit holds is charged
  // again when it resumes, and must still find a token after later spawns spent theirs.
  const capacity = Math.max(
    1,
    Math.min(limits.userResumeBucketCapacity - 1, limits.userResumeConcurrency)
  )
  let bucket: TokenBucket = { tokens: capacity, updatedAt: now() }
  let queue: Promise<void> = Promise.resolve()

  const current = (): TokenBucket => {
    bucket = refill(bucket, capacity, tokensPerMs, now())
    return bucket
  }
  const spend = (): void => {
    bucket = { tokens: Math.max(0, current().tokens - 1), updatedAt: bucket.updatedAt }
  }

  return {
    take: () => {
      // Why serial: each waiter must see the token its predecessor spent.
      const turn = queue.then(async () => {
        while (current().tokens < 1) {
          await sleep(Math.ceil((1 - bucket.tokens) / tokensPerMs))
        }
        spend()
      })
      queue = turn
      return turn
    },
    note: () => {
      if (current().tokens >= 1) {
        spend()
      }
    }
  }
}

/** One per main process: the daemon keys its bucket by this process's client connection. */
export const userResumeSpawnPacer = createUserResumeSpawnPacer()
