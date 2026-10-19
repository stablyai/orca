import { afterEach, expect, it, vi } from 'vitest'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { createStructuredSessionObservationClock } from './structured-agent-session-observation-clock.test-fixture'

const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout

afterEach(() => vi.useRealTimers())

it('restores the clock before pending cleanup and propagates its real deadline failure', async () => {
  const clock = createStructuredSessionObservationClock(() => {
    throw new Error('cleanup must not access a session host')
  }, 'cleanup-clock')
  const phaseFailure = new Error('teardown phase timed out')
  let releasePhase: () => void = () => {}
  const pendingPhase = new Promise<void>((resolve) => {
    releasePhase = resolve
  })
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let observationFired = false
  clock.start()
  setTimeout(() => {
    observationFired = true
  }, 1)

  try {
    const cleanup = clock.restoreBeforeCleanup(async () => {
      const outcome = await withTimeout<void | null>(pendingPhase, 10, null)
      if (outcome === null) {
        throw phaseFailure
      }
    })
    const guardedCleanup = Promise.race([
      cleanup,
      new Promise<never>((_, reject) => {
        watchdog = realSetTimeout(() => reject(new Error('cleanup deadline stayed frozen')), 1_000)
      })
    ])
    expect(vi.isFakeTimers()).toBe(false)
    await expect(guardedCleanup).rejects.toBe(phaseFailure)
    expect(vi.isFakeTimers()).toBe(false)
    expect(observationFired).toBe(false)
  } finally {
    clock.restore()
    realClearTimeout(watchdog)
    releasePhase()
  }
})
