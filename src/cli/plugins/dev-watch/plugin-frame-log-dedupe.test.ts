import { describe, expect, it } from 'vitest'
import type { PluginLogLine } from './plugin-log-follower'
import {
  DEFAULT_MAX_FRAME_LOG_DEDUPE_ENTRIES,
  PluginFrameLogDedupe
} from './plugin-frame-log-dedupe'

const frameLine = (id: string, ts: number): PluginLogLine => ({
  ts,
  level: 'warn',
  line: `[frame] ${id}`
})

describe('PluginFrameLogDedupe', () => {
  it('bounds retained keys under unique frame log churn', () => {
    const dedupe = new PluginFrameLogDedupe()

    for (let batchStart = 0; batchStart < 5000; batchStart += 100) {
      const batch = Array.from({ length: 100 }, (_, offset) =>
        frameLine(`unique-${batchStart + offset}`, batchStart + offset)
      )
      const emitted = dedupe.take(batch)
      expect(emitted).toHaveLength(100)
      expect(dedupe.size).toBeLessThanOrEqual(DEFAULT_MAX_FRAME_LOG_DEDUPE_ENTRIES)
    }

    expect(dedupe.size).toBe(DEFAULT_MAX_FRAME_LOG_DEDUPE_ENTRIES)
    expect(dedupe.flush()).toEqual([])
    expect(dedupe.size).toBe(0)
  })

  it('preserves duplicate summaries across LRU eviction and active key refreshes', () => {
    const dedupe = new PluginFrameLogDedupe(2)

    expect(dedupe.take([frameLine('alpha', 1), frameLine('beta', 2)])).toEqual([
      frameLine('alpha', 1),
      frameLine('beta', 2)
    ])

    // Both keys repeat; alpha is touched last so beta becomes least-recently-used.
    expect(
      dedupe.take([frameLine('beta', 3), frameLine('alpha', 4), frameLine('alpha', 5)])
    ).toEqual([])

    // Adding gamma evicts beta and emits beta's pending repeat summary without losing it.
    expect(dedupe.take([frameLine('gamma', 6)])).toEqual([
      frameLine('gamma', 6),
      { ...frameLine('beta', 3), count: 1, repeat: true }
    ])
    expect(dedupe.size).toBe(2)

    // Alpha stayed hot and still accumulates repeats until flush.
    expect(dedupe.take([frameLine('alpha', 7)])).toEqual([])
    expect(dedupe.flush()).toEqual([{ ...frameLine('alpha', 7), count: 3, repeat: true }])
    expect(dedupe.size).toBe(0)
  })
})
