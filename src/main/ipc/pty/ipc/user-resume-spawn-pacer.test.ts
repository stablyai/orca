import { describe, expect, it } from 'vitest'
import { DEFAULT_SPAWN_ADMISSION_LIMITS } from '../../../../shared/host-spawn-admission'
import { createUserResumeSpawnPacer } from './user-resume-spawn-pacer'

function fakeClock() {
  let time = 0
  const sleeps: number[] = []
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      time += ms
    },
    advance: (ms: number) => {
      time += ms
    },
    sleeps
  }
}

describe('user-resume spawn pacer', () => {
  it("lets a burst through one short of the daemon's bucket, then waits for each refill", async () => {
    const clock = fakeClock()
    const pacer = createUserResumeSpawnPacer({ now: clock.now, sleep: clock.sleep })
    const takenAt: number[] = []

    await Promise.all(
      Array.from({ length: 12 }, () => pacer.take().then(() => takenAt.push(clock.now())))
    )

    const refillMs =
      DEFAULT_SPAWN_ADMISSION_LIMITS.userResumeBucketWindowMs /
      DEFAULT_SPAWN_ADMISSION_LIMITS.userResumeBucketCapacity
    expect(takenAt.slice(0, 3)).toEqual([0, 0, 0])
    expect(takenAt.slice(3)).toEqual(
      Array.from({ length: 9 }, (_, index) => refillMs * (index + 1))
    )
  })

  it('counts unpaced user resumes against the same bucket', async () => {
    const clock = fakeClock()
    const pacer = createUserResumeSpawnPacer({ now: clock.now, sleep: clock.sleep })
    for (let i = 0; i < 3; i++) {
      pacer.note()
    }

    await pacer.take()

    expect(clock.sleeps.length).toBeGreaterThan(0)
  })

  it('does not wait once the bucket has refilled', async () => {
    const clock = fakeClock()
    const pacer = createUserResumeSpawnPacer({ now: clock.now, sleep: clock.sleep })
    for (let i = 0; i < 3; i++) {
      await pacer.take()
    }
    clock.advance(DEFAULT_SPAWN_ADMISSION_LIMITS.userResumeBucketWindowMs)

    await pacer.take()

    expect(clock.sleeps).toEqual([])
  })
})
