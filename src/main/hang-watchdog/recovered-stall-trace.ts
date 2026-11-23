import { startSpan } from '../observability/tracer'

/** Puts a recovered stall in this session's trace; the stacks stay in main-thread-hang.json. */
export function recordRecoveredMainThreadStall(stall: {
  tier: 'stall' | 'hang'
  unresponsiveMs: number
  endedAt: number
}): void {
  // Ended at once: the span marks when main answered again; the attributes carry the interval.
  startSpan('main_thread.stall', {
    attributes: {
      kind: 'hang-watchdog',
      'stall.tier': stall.tier,
      'stall.unresponsive_ms': Math.round(stall.unresponsiveMs),
      'stall.started_at_ms': Math.round(stall.endedAt - stall.unresponsiveMs),
      'stall.ended_at_ms': Math.round(stall.endedAt)
    }
  }).end()
}
