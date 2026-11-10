import { describe, expect, it } from 'vitest'
import {
  PRECONNECT_MAX_MS,
  PRECONNECT_RETRY_MS,
  startWakePreconnect,
  waitForControlReadySince
} from './recipe-vm-wake-preconnect'

function clock() {
  let now = 0
  const timers: { at: number; run: () => void; id: number }[] = []
  let nextId = 1
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const id = nextId++
      timers.push({ at: now + ms, run, id })
      return () => {
        const index = timers.findIndex((t) => t.id === id)
        if (index !== -1) {
          timers.splice(index, 1)
        }
      }
    },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) {
          break
        }
        timers.shift()
        now = next.at
        next.run()
      }
      now = end
    },
    pending: () => timers.length
  }
}

describe('wake pre-connect', () => {
  it('keeps nudging the scheduled reconnect until the socket is ready, then stops', () => {
    const c = clock()
    let ready = false
    let ensured = 0
    let retries = 0
    startWakePreconnect({
      ensure: () => ensured++,
      isReady: () => ready,
      retryNow: () => retries++,
      isWaking: () => true,
      ...c
    })
    expect(ensured).toBe(1)
    c.advance(PRECONNECT_RETRY_MS * 5)
    expect(retries).toBe(5)
    ready = true
    c.advance(PRECONNECT_RETRY_MS * 5)
    expect(retries).toBe(5)
    expect(c.pending()).toBe(0)
  })

  it('stops when the wake ends, when stopped, and at the cap', () => {
    const c = clock()
    let waking = true
    let retries = 0
    startWakePreconnect({
      ensure: () => {},
      isReady: () => false,
      retryNow: () => retries++,
      isWaking: () => waking,
      ...c
    })
    c.advance(PRECONNECT_RETRY_MS)
    waking = false
    c.advance(PRECONNECT_RETRY_MS * 3)
    expect(retries).toBe(1)

    const c2 = clock()
    let retries2 = 0
    const stop = startWakePreconnect({
      ensure: () => {},
      isReady: () => false,
      retryNow: () => retries2++,
      isWaking: () => true,
      ...c2
    })
    stop()
    c2.advance(PRECONNECT_RETRY_MS * 3)
    expect(retries2).toBe(0)

    const c3 = clock()
    let retries3 = 0
    startWakePreconnect({
      ensure: () => {},
      isReady: () => false,
      retryNow: () => retries3++,
      isWaking: () => true,
      ...c3
    })
    c3.advance(PRECONNECT_MAX_MS * 2)
    expect(retries3).toBeLessThanOrEqual(Math.ceil(PRECONNECT_MAX_MS / PRECONNECT_RETRY_MS))
    expect(c3.pending()).toBe(0)
  })

  it('survives a throwing nudge and a throwing ensure', () => {
    const c = clock()
    let retries = 0
    startWakePreconnect({
      ensure: () => {},
      isReady: () => false,
      retryNow: () => {
        retries++
        throw new Error('boom')
      },
      isWaking: () => true,
      ...c
    })
    c.advance(PRECONNECT_RETRY_MS * 3)
    expect(retries).toBe(3)
    const c2 = clock()
    startWakePreconnect({
      ensure: () => {
        throw new Error('no pairing')
      },
      isReady: () => false,
      retryNow: () => {},
      isWaking: () => true,
      ...c2
    })
    expect(c2.pending()).toBe(0)
  })

  it('treats only a socket that became ready after the wake began as proof', async () => {
    const c = clock()
    let readyAt: number | null = 50
    const result = waitForControlReadySince({
      lastReadyAt: () => readyAt,
      since: 100,
      timeoutMs: 1_000,
      pollMs: 50,
      now: c.now,
      setTimer: c.setTimer
    })
    c.advance(200)
    readyAt = 250
    c.advance(100)
    await expect(result).resolves.toBe(true)

    const timedOut = waitForControlReadySince({
      lastReadyAt: () => null,
      since: 0,
      timeoutMs: 500,
      pollMs: 50,
      now: c.now,
      setTimer: c.setTimer
    })
    c.advance(600)
    await expect(timedOut).resolves.toBe(false)
  })
})
