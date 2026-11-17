import { describe, expect, it } from 'vitest'
import { createEventLoopStallSummary, type EventLoopStallWindow } from './event-loop-delay-probe'

function ticks(summary: ReturnType<typeof createEventLoopStallSummary>, times: number[]): void {
  for (const time of times) {
    summary.tick(time)
  }
}

describe('createEventLoopStallSummary', () => {
  it('reports a window with the longest gap and every stall in it', () => {
    const windows: EventLoopStallWindow[] = []
    const summary = createEventLoopStallSummary(0, (window) => windows.push(window))
    // On-time ticks, a 5s block, a 300ms block, then on time until the minute ends.
    ticks(summary, [500, 1_000, 6_500, 7_300, 7_800])
    for (let time = 8_300; time <= 60_300; time += 500) {
      summary.tick(time)
    }
    expect(windows).toEqual([{ windowMs: 60_300, maxGapMs: 5_000, stalls: 2, stalledMs: 5_300 }])
  })

  it('writes nothing for a quiet window and never counts system sleep', () => {
    const windows: EventLoopStallWindow[] = []
    const summary = createEventLoopStallSummary(0, (window) => windows.push(window))
    ticks(summary, [500, 1_000])
    summary.pause()
    // Timers stop while asleep; the first tick after it is late by the sleep, not by a stall.
    summary.tick(40_000)
    summary.resume(40_010)
    for (let time = 40_510; time <= 61_000; time += 500) {
      summary.tick(time)
    }
    expect(windows).toEqual([])
  })
})
