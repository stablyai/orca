import { afterEach, expect, it, vi } from 'vitest'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../../shared/generated-agent-input-readiness'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../../shared/terminal-input'
import { GeneratedInputParts } from './generated-input-parts'

afterEach(() => {
  vi.useRealTimers()
})

const first = (id: string, text = 'a') => ({ text, part: { id, index: 0, final: false } })
const next = (id: string, index: number, final: boolean, text = 'b') => ({
  text,
  part: { id, index, final }
})

// L10: each owner holds at most 32 unfinished uploads; every way an upload ends frees its slot.
it('caps unfinished uploads per owner and releases a slot on every ending', () => {
  vi.useFakeTimers()
  const parts = new GeneratedInputParts()
  const other = new GeneratedInputParts()
  for (let index = 0; index < 32; index += 1) {
    expect(parts.accept('caller', first(`op-${index}`), 'target')).toEqual({ kind: 'pending' })
    expect(other.accept('caller', first(`op-${index}`))).toEqual({ kind: 'pending' })
  }
  // The 33rd is refused without disturbing the 32 already accepted; the limit is per owner.
  expect(() => parts.accept('caller', first('op-33'))).toThrow('Too many')
  expect(() => other.accept('caller', first('op-33'))).toThrow('Too many')
  expect(vi.getTimerCount()).toBe(64)
  const successor = (id: string) => {
    expect(parts.accept('caller', first(id))).toEqual({ kind: 'pending' })
    expect(() => parts.accept('caller', first('op-overflow'))).toThrow('Too many')
  }

  // Final part.
  expect(parts.accept('caller', next('op-0', 1, true), 'target')).toEqual({
    kind: 'complete',
    text: 'ab',
    deadline: expect.any(Number)
  })
  successor('op-final')
  // A part naming another target.
  expect(() => parts.accept('caller', next('op-1', 1, false), 'elsewhere')).toThrow('out of order')
  successor('op-binding')
  // Too large once assembled.
  expect(() =>
    parts.accept('caller', next('op-2', 1, false, 'x'.repeat(TERMINAL_INPUT_MAX_BYTES)), 'target')
  ).toThrow('too large')
  successor('op-oversize')
  // An accepted part survives until the deadline, not past it.
  expect(parts.accept('caller', next('op-3', 1, false), 'target')).toEqual({ kind: 'pending' })
  vi.advanceTimersByTime(GENERATED_AGENT_INPUT_TIMEOUT_MS - 1)
  expect(() => parts.accept('caller', first('op-overflow'))).toThrow('Too many')
  vi.advanceTimersByTime(1)
  // Every upload of both owners expired: no timer remains and every slot is free again.
  expect(vi.getTimerCount()).toBe(0)
  expect(() => parts.accept('caller', next('op-3', 2, true), 'target')).toThrow('out of order')
  for (let index = 0; index < 32; index += 1) {
    expect(parts.accept('caller', first(`fresh-${index}`))).toEqual({ kind: 'pending' })
  }
  expect(() => parts.accept('caller', first('fresh-33'))).toThrow('Too many')
})

// CNG2 multipart: the first part's end bounds the upload. A later part may bring it closer, never
// further; an upload past its end is refused even before its cleanup timer has run.
it('lets a later part tighten an upload’s end, never extend it', () => {
  vi.useFakeTimers()
  const start = Date.now()
  const parts = new GeneratedInputParts()
  const part = (index: number, final: boolean, timeoutMs?: number) => ({
    text: `p${index}`,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    part: { id: 'op', index, final }
  })
  expect(parts.accept('caller', part(0, false, 1000), 'target')).toEqual({ kind: 'pending' })
  // More time later is not granted; no time given is not a renewal; both stay the same upload.
  vi.setSystemTime(start + 500)
  expect(parts.accept('caller', part(1, false, 5000), 'target')).toEqual({ kind: 'pending' })
  expect(parts.accept('caller', part(2, false), 'target')).toEqual({ kind: 'pending' })
  // Less time left tightens the end to now + 100.
  expect(parts.accept('caller', part(3, false, 100), 'target')).toEqual({ kind: 'pending' })
  expect(vi.getTimerCount()).toBe(1)
  // Past that end, before its timer runs: the final part is refused and the upload is gone.
  vi.setSystemTime(start + 650)
  expect(() => parts.accept('caller', part(4, true, 900), 'target')).toThrow('expired')
  expect(vi.getTimerCount()).toBe(0)
  expect(() => parts.accept('caller', part(5, true), 'target')).toThrow('out of order')

  // In time, the final part completes with the tightest end, which the host's queue then spends.
  vi.setSystemTime(start)
  parts.accept('caller', { ...part(0, false, 1000), part: { id: 'kept', index: 0, final: false } })
  vi.setSystemTime(start + 200)
  expect(
    parts.accept('caller', { ...part(1, true, 300), part: { id: 'kept', index: 1, final: true } })
  ).toEqual({ kind: 'complete', text: 'p0p1', deadline: start + 500 })
})
