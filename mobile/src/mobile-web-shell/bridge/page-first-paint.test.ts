import { describe, expect, it } from 'vitest'
import { reportAfterFirstPaint } from './page-first-paint'

/** Frames the caller drains by hand, so "one frame later" is a step rather than a wait. */
function frames() {
  const queued: (() => void)[] = []
  return {
    schedule: (callback: () => void) => {
      queued.push(callback)
    },
    tick: () => {
      const next = queued.shift()
      next?.()
    },
    pending: () => queued.length
  }
}

describe('when the page says it has a frame', () => {
  it('waits for a frame boundary past the commit, never the same one', () => {
    // One frame is the frame that paints the commit, and a callback inside it can still run ahead
    // of the paint. Reporting there would uncover the view over a tree nothing has drawn.
    const clock = frames()
    let reported = 0
    reportAfterFirstPaint(clock.schedule, () => {
      reported += 1
    })
    expect(reported).toBe(0)
    clock.tick()
    expect(reported).toBe(0)
    clock.tick()
    expect(reported).toBe(1)
  })

  it('reports once and schedules nothing after it', () => {
    const clock = frames()
    reportAfterFirstPaint(clock.schedule, () => {})
    clock.tick()
    clock.tick()
    expect(clock.pending()).toBe(0)
  })
})
