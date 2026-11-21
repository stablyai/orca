import { describe, expect, it } from 'vitest'
import {
  createEventLoopStallSummary,
  type EventLoopStallSummaryOptions,
  type EventLoopStallWindow
} from './event-loop-delay-probe'

const MINUTE: EventLoopStallSummaryOptions = {
  tickMs: 500,
  windowMs: 60_000,
  reportableMaxGapMs: 100,
  maxCountedGapMs: 60_000
}

function onTimeUntil(
  summary: ReturnType<typeof createEventLoopStallSummary>,
  from: number,
  to: number,
  cpuMs = 0
): void {
  for (let time = from; time <= to; time += 500) {
    summary.tick(time, cpuMs)
  }
}

describe('createEventLoopStallSummary', () => {
  it('reports the worst gap, its CPU, and every stall it saw in the window', () => {
    const windows: EventLoopStallWindow[] = []
    const summary = createEventLoopStallSummary(0, MINUTE, (window) => windows.push(window))
    summary.tick(500, 0)
    summary.tick(1_000, 10)
    // A 5 s block that burned 4.9 s of CPU, then a 300 ms one.
    summary.tick(6_500, 4_910)
    summary.tick(7_300, 5_000)
    onTimeUntil(summary, 7_800, 60_300, 5_000)
    expect(windows).toEqual([
      {
        windowMs: 60_300,
        maxGapMs: 5_000,
        maxGapCpuMs: 4_900,
        stallsSeen: 2,
        stalledMsSeen: 5_300,
        cpuMs: 5_000,
        uncountedMaxGapMs: 0,
        idleTickMaxCpuMs: 0
      }
    ])
  })

  it('never counts system sleep, and keeps a missed sleep out of the stall counts', () => {
    const windows: EventLoopStallWindow[] = []
    const summary = createEventLoopStallSummary(0, MINUTE, (window) => windows.push(window))
    summary.tick(500)
    summary.pause()
    summary.tick(40_000)
    summary.resume(40_010)
    // No suspend event: the clock ran on through a 2 h sleep.
    summary.tick(7_240_010)
    onTimeUntil(summary, 7_240_510, 7_300_010)
    expect(windows).toEqual([
      {
        windowMs: 7_240_010,
        maxGapMs: 0,
        maxGapCpuMs: 0,
        stallsSeen: 0,
        stalledMsSeen: 0,
        cpuMs: 0,
        uncountedMaxGapMs: 7_199_500,
        idleTickMaxCpuMs: 0
      }
    ])
  })

  it('writes nothing for a reported sleep, however long', () => {
    const windows: EventLoopStallWindow[] = []
    const summary = createEventLoopStallSummary(0, MINUTE, (window) => windows.push(window))
    summary.tick(500)
    summary.pause()
    summary.tick(3_600_500)
    summary.resume(3_600_510)
    onTimeUntil(summary, 3_601_010, 3_720_010)
    expect(windows).toEqual([])
  })

  it('holds a stalled window until it can be recorded, then reports all of it', () => {
    const windows: EventLoopStallWindow[] = []
    let sinkReady = false
    const summary = createEventLoopStallSummary(
      0,
      { ...MINUTE, canReport: () => sinkReady },
      (window) => windows.push(window)
    )
    summary.tick(2_000)
    onTimeUntil(summary, 2_500, 70_000)
    expect(windows).toEqual([])
    sinkReady = true
    summary.tick(70_500)
    expect(windows).toEqual([
      {
        windowMs: 70_500,
        maxGapMs: 1_500,
        maxGapCpuMs: 0,
        stallsSeen: 1,
        stalledMsSeen: 1_500,
        cpuMs: 0,
        uncountedMaxGapMs: 0,
        idleTickMaxCpuMs: 0
      }
    ])
  })

  it('ticks rarely only after main has been quiet, and still reports what the slow ticks hid', () => {
    const windows: EventLoopStallWindow[] = []
    const summary = createEventLoopStallSummary(
      0,
      { ...MINUTE, idle: { afterMs: 30_000, tickMs: 10_000 } },
      (window) => windows.push(window)
    )
    onTimeUntil(summary, 500, 29_000)
    expect(summary.tick(29_500, 0)).toBe(500)
    expect(summary.tick(30_000, 0)).toBe(10_000)
    // A 2 s block between idle ticks: the tick lands on time, but its CPU is kept and busy ticking resumes.
    expect(summary.tick(40_000, 2_000)).toBe(500)
    expect(summary.tick(40_500, 2_000)).toBe(500)
    onTimeUntil(summary, 41_000, 69_500, 2_000)
    expect(summary.tick(70_000, 2_000)).toBe(10_000)
    // No suspend event: the clock ran on through 65 s of sleep after an idle tick.
    expect(summary.tick(135_000, 2_000)).toBe(500)
    expect(windows).toEqual([
      {
        windowMs: 60_000,
        maxGapMs: 0,
        maxGapCpuMs: 0,
        stallsSeen: 0,
        stalledMsSeen: 0,
        cpuMs: 2_000,
        uncountedMaxGapMs: 0,
        idleTickMaxCpuMs: 2_000
      },
      {
        windowMs: 75_000,
        maxGapMs: 0,
        maxGapCpuMs: 0,
        stallsSeen: 0,
        stalledMsSeen: 0,
        cpuMs: 0,
        uncountedMaxGapMs: 55_000,
        idleTickMaxCpuMs: 0
      }
    ])
  })

  it('counts every gap when no cap is set, reporting at the tick that closed the window', () => {
    const reports: [EventLoopStallWindow, number][] = []
    const summary = createEventLoopStallSummary(
      0,
      { tickMs: 25, windowMs: 2_000, reportableMaxGapMs: 0 },
      (window, now) => reports.push([window, now])
    )
    summary.tick(60_025)
    expect(reports.map(([window, now]) => [window.maxGapMs, now])).toEqual([[60_000, 60_025]])
  })
})
