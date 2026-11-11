import { describe, expect, it } from 'vitest'
import { createAccumulator, finalizeSession, updateTimeline } from './session-scanner-accumulator'

function accumulator() {
  return createAccumulator({
    agent: 'claude',
    sessionId: 'timeline-test',
    file: { path: 'transcript.jsonl', mtimeMs: 0, modifiedAt: '2026-01-01T00:00:00.000Z' }
  })
}

describe('session timeline bounds', () => {
  it('retains earliest and latest timestamps despite duplicates and out-of-order records', () => {
    const state = accumulator()
    for (const timestamp of [
      '2026-01-03T01:00:00+01:00',
      '2026-01-01T00:00:00Z',
      '2026-01-04T00:00:00Z',
      '2026-01-02T00:00:00Z',
      '2026-01-04T00:00:00Z'
    ]) {
      updateTimeline(state, timestamp)
    }
    expect(finalizeSession(state, 'linux')).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z'
    })
    expect(state.latestTimestampMs).toBe(Date.parse('2026-01-04T00:00:00Z'))
  })

  it('compares fractional numeric timestamps against the rounded ISO bound', () => {
    const state = accumulator()
    const base = 1_700_000_000_000
    updateTimeline(state, base + 0.9)
    updateTimeline(state, base + 0.1)
    expect(state.latestTimestampMs).toBe(base + 0.1)
    expect(state.createdAt).toBe(new Date(base).toISOString())
    updateTimeline(state, base - 0.1)
    expect(state.createdAt).toBe(new Date(base - 1).toISOString())
    expect(state.latestTimestampMs).toBe(base + 0.1)
  })
})
