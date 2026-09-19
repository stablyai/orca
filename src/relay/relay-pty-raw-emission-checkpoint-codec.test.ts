import { expect, it } from 'vitest'
import { advanceRelayPtyRawEmissionCheckpoint as advance } from './relay-pty-raw-emission-checkpoint'
import { parseRelayPtyRawEmissionCheckpoint as parse } from './relay-pty-raw-emission-checkpoint-codec'

const slice = {
  emissionId: '100:112',
  rawStartSu: 100,
  rawEndSu: 112,
  displayStartSu: 0,
  displayEndSu: 5,
  displayLengthSu: 5
}
const complete = advance(undefined, slice, 8, 9)
const pending = advance(undefined, { ...slice, displayEndSu: 2 }, 8, 8)

it('leaves legacy absent metadata absent without inferring raw progress', () => {
  expect(parse(undefined, 999)).toBeUndefined()
  expect(() => parse(null, 999)).toThrow('journal_invalid')
})

it('restores independent raw/display progress into detached immutable records', () => {
  const input = JSON.parse(JSON.stringify(complete))
  const restored = parse(input, 9)!
  expect(restored).toEqual(complete)
  input.lastObserved.slice.rawEndSu = 999
  expect(restored.lastObserved.slice.rawEndSu).toBe(112)
  expect(Object.isFrozen(restored)).toBe(true)
  expect(Object.isFrozen(restored.lastObserved)).toBe(true)
  expect(Object.isFrozen(restored.lastObserved.slice)).toBe(true)
  expect(advance(restored, slice, 8, 9)).toBe(restored)
})

it('allows completed source checkpoints to precede later destination journal output', () => {
  expect(parse(complete, 99)).toEqual(complete)
})

it('restores partial emissions without advancing the completed cursor', () => {
  const restored = parse(pending, 8)!
  expect(restored).toEqual(pending)
  expect(Object.isFrozen(restored.pending)).toBe(true)
  const second = advance(restored, { ...slice, displayStartSu: 2, displayEndSu: 3 }, 9, 9)
  expect(parse(second, 9)).toEqual(second)
  const final = advance(parse(second, 9), { ...slice, displayStartSu: 3 }, 10, 10)
  expect(parse(final, 10)).toEqual(final)
  expect(final.rawEndSu).toBe(112)
})

it('restores zero-display emissions with no synthetic journal sequence', () => {
  const empty = advance(undefined, { ...slice, displayEndSu: 0, displayLengthSu: 0 }, 1, 0)
  expect(parse(empty, 0)).toEqual(empty)
})

it.each([
  { rawOriginSu: -1 },
  { rawOriginSu: 101 },
  { rawOriginSu: '100' },
  { rawEndSu: 111 },
  { rawEndSu: Number.MAX_SAFE_INTEGER + 1 },
  { journalThroughSeq: 8 },
  { journalThroughSeq: Infinity },
  { lastObserved: null },
  { pending: slice }
])('rejects malformed completed checkpoint %j', (change) => {
  expect(() => parse({ ...complete, ...change }, 9)).toThrow('journal_invalid')
})

it.each([
  { emissionId: '0100:112' },
  { emissionId: 'other' },
  { rawStartSu: 112 },
  { displayEndSu: 6 },
  { displayEndSu: 4 },
  { displayStartSu: 5 },
  { displayLengthSu: -1 }
])('rejects malformed last emission %j', (change) => {
  expect(() =>
    parse(
      { ...complete, lastObserved: { ...complete.lastObserved, slice: { ...slice, ...change } } },
      9
    )
  ).toThrow('journal_invalid')
})

it.each([
  { rawEndSu: 101 },
  { journalThroughSeq: 6 },
  { journalThroughSeq: 8 },
  { pending: undefined },
  { pending: { ...pending.pending, displayEndSu: 3 } },
  { pending: { ...pending.pending, emissionId: '100:113', rawEndSu: 113 } }
])('rejects inconsistent pending checkpoint %j', (change) => {
  expect(() => parse({ ...pending, ...change }, 8)).toThrow('journal_invalid')
})

it('rejects journal gaps before later pending slices and cursors beyond the durable journal', () => {
  const second = advance(pending, { ...slice, displayStartSu: 2, displayEndSu: 3 }, 9, 9)
  expect(() => parse({ ...second, journalThroughSeq: 8 }, 9)).toThrow('journal_invalid')
  expect(() => parse(complete, 8)).toThrow('journal_invalid')
  expect(() => parse(pending, 7)).toThrow('journal_invalid')
  expect(() =>
    parse({ ...complete, lastObserved: { ...complete.lastObserved, journalFirstSeq: 10 } }, 9)
  ).toThrow('journal_invalid')
})
