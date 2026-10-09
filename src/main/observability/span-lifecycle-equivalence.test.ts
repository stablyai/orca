import { afterEach, expect, it, vi } from 'vitest'
import {
  createHangWatchdogSpanTracker,
  readHangWatchdogSpanSnapshot
} from '../hang-watchdog/hang-watchdog-active-spans'
import { subscribeSpanLifecycle } from './span-lifecycle'
import { setActiveSink, startSpan, withSpan } from './tracer'

afterEach(() => {
  setActiveSink(null)
  vi.restoreAllMocks()
})

function stableRecord(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !['traceId', 'spanId', 'parentSpanId'].includes(key))
  )
}

async function captureRecords(tracking: boolean): Promise<unknown[]> {
  const records: unknown[] = []
  setActiveSink({ push: (record) => records.push(stableRecord(record)), flush() {}, close() {} })
  const tracker = createHangWatchdogSpanTracker()
  const unsubscribe = tracking ? subscribeSpanLifecycle(tracker.observer) : () => {}
  try {
    await withSpan('git.exec', async () => {
      const child = startSpan('worktree.create', {
        attributes: { command: 'private text', token: 'secret' }
      })
      child.addEvent('stage', { count: 1 })
      child.end()
      child.end()
      startSpan('git.exec', { shouldRecord: () => false }).end()
      startSpan('dynamic/private/path').interrupt('cancelled')
      startSpan('git.exec').fail('failed')
    })
    expect(readHangWatchdogSpanSnapshot(tracker.buffer, Date.now()).inFlightSpans).toEqual([])
    return records
  } finally {
    unsubscribe()
    tracker.clear()
  }
}

it('preserves trace records with tracking enabled, including filtering and all exit paths', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const withoutTracking = await captureRecords(false)
  const withTracking = await captureRecords(true)
  expect(withTracking).toEqual(withoutTracking)
  expect(withTracking).toHaveLength(4)
})

it('keeps storage reusable across sustained span bursts and stops observing after unsubscribe', () => {
  const tracker = createHangWatchdogSpanTracker()
  setActiveSink({ push() {}, flush() {}, close() {} })
  const unsubscribe = subscribeSpanLifecycle(tracker.observer)
  try {
    for (let burst = 0; burst < 20; burst++) {
      const spans = Array.from({ length: 64 }, () => startSpan('git.exec'))
      expect(readHangWatchdogSpanSnapshot(tracker.buffer, Date.now()).inFlightSpans).toHaveLength(
        64
      )
      for (const span of spans) {
        span.end()
      }
      expect(readHangWatchdogSpanSnapshot(tracker.buffer, Date.now())).toEqual({
        inFlightSpans: [],
        droppedSpanCount: 0
      })
    }
    unsubscribe()
    const later = startSpan('git.exec')
    expect(readHangWatchdogSpanSnapshot(tracker.buffer, Date.now()).inFlightSpans).toEqual([])
    later.end()
  } finally {
    unsubscribe()
    tracker.clear()
  }
})
