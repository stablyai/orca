import { describe, expect, it, vi } from 'vitest'
import {
  cloneSessionAccumulator,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'

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

  it('preserves pre-epoch and extended-year ISO timestamps', () => {
    const state = accumulator()
    updateTimeline(state, '+010000-01-01T00:00:00.000Z')
    updateTimeline(state, '-000001-01-01T00:00:00.000Z')
    updateTimeline(state, '1969-12-31T23:59:59.999Z')
    expect(state.createdAt).toBe('-000001-01-01T00:00:00.000Z')
    expect(state.updatedAt).toBe('+010000-01-01T00:00:00.000Z')
  })

  it('ignores invalid timestamps and retains the existing out-of-range error', () => {
    const state = accumulator()
    for (const timestamp of [null, undefined, '', 'bad-date', 0, -1, Number.NaN, Infinity]) {
      updateTimeline(state, timestamp)
    }
    expect(state.createdAt).toBeNull()
    expect(state.updatedAt).toBeNull()
    expect(() => updateTimeline(state, 8_640_000_000_000_001)).toThrow(RangeError)
    expect(state.createdAt).toBeNull()
    expect(state.updatedAt).toBeNull()
  })

  it('keeps cloned parse-state bounds independent', () => {
    const state = accumulator()
    updateTimeline(state, '2026-01-02T00:00:00Z')
    const clone = cloneSessionAccumulator(state)
    updateTimeline(clone, '2026-01-01T00:00:00Z')
    updateTimeline(clone, '2026-01-03T00:00:00Z')
    expect(state.createdAt).toBe('2026-01-02T00:00:00.000Z')
    expect(state.updatedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(clone.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(clone.updatedAt).toBe('2026-01-03T00:00:00.000Z')
  })

  it('does not reparse accumulated bounds for every numeric record', () => {
    const state = accumulator()
    const spy = vi.spyOn(Date, 'parse')
    let parseCalls: number
    try {
      for (let index = 0; index < 1000; index += 1) {
        updateTimeline(state, 1_700_000_000_000 + index)
      }
      parseCalls = spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
    expect(state.latestTimestampMs).toBe(1_700_000_000_999)
    expect(parseCalls).toBe(0)
  })
})
