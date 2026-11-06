import { describe, expect, it } from 'vitest'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { AtRestCommandDemand } from './at-rest-command-demand'

describe('legacy discovery admission takeover', () => {
  it.each(['before-grant', 'after-grant'] as const)(
    'withdraws the same acquisition %s and returns the permit once',
    async (race) => {
      const pool = new PrioritySemaphore(1)
      const held = await pool.acquire(0)
      const demand = new AtRestCommandDemand(false)
      const signal = new AbortController().signal
      const queued = demand.acquire(pool, signal)
      if (race === 'after-grant') {
        held()
      }
      demand.request()
      const independentRelease = await queued
      if (race === 'before-grant') {
        held()
      }
      const next = await pool.acquire(0)
      independentRelease()
      let duplicatePermit = false
      const blocked = pool.acquire(0).then((release) => {
        duplicatePermit = true
        return release
      })
      await Promise.resolve()
      expect(duplicatePermit).toBe(false)
      next()
      ;(await blocked)()
    }
  )

  it('joins an admitted attempt and retains its legacy permit through cleanup', async () => {
    const pool = new PrioritySemaphore(1)
    const demand = new AtRestCommandDemand(false)
    const release = await demand.acquire(pool, new AbortController().signal)
    demand.request()
    let admitted = false
    const waiting = pool.acquire(0).then((done) => {
      admitted = true
      return done
    })
    await Promise.resolve()
    expect(admitted).toBe(false)
    release()
    ;(await waiting)()
  })
})
