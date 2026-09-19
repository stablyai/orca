import { expect, it } from 'vitest'
import {
  advanceRelayPtyRawEmissionCheckpoint as advance,
  type RelayPtyRawEmissionSlice
} from './relay-pty-raw-emission-checkpoint'

const emission: RelayPtyRawEmissionSlice = {
  emissionId: 'raw-100-112',
  rawStartSu: 100,
  rawEndSu: 112,
  displayStartSu: 0,
  displayEndSu: 5,
  displayLengthSu: 5
}

it('records raw units independently from display length and delivery origin', () => {
  const result = advance(undefined, emission, 8, 9)
  expect(result).toMatchObject({ rawOriginSu: 100, rawEndSu: 112, journalThroughSeq: 9 })
  expect(result.pending).toBeUndefined()
  expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.lastObserved.slice)).toBe(true)
})

it('holds raw and journal progress until all bounded display slices are observed', () => {
  const first = advance(undefined, { ...emission, displayEndSu: 2 }, 8, 8)
  expect(first).toMatchObject({ rawEndSu: 100, journalThroughSeq: 7 })
  const final = advance(first, { ...emission, displayStartSu: 2 }, 9, 10)
  expect(final).toMatchObject({ rawEndSu: 112, journalThroughSeq: 10 })
  expect(final.pending).toBeUndefined()
  expect(first.pending?.displayEndSu).toBe(2)
})

it('advances zero-display raw emissions without allocating a journal frame', () => {
  const first = advance(undefined, emission, 8, 8)
  const next = advance(
    first,
    {
      emissionId: 'empty',
      rawStartSu: 112,
      rawEndSu: 119,
      displayStartSu: 0,
      displayEndSu: 0,
      displayLengthSu: 0
    },
    9,
    8
  )
  expect(next).toMatchObject({ rawEndSu: 119, journalThroughSeq: 8 })
})

it('returns exact immediate retries unchanged, including after serialization', () => {
  const first = advance(undefined, emission, 8, 8)
  expect(advance(first, { ...emission }, 8, 8)).toBe(first)
  const restored = JSON.parse(JSON.stringify(first))
  expect(advance(restored, emission, 8, 8)).toBe(restored)
  expect(() => advance(first, emission, 9, 9)).toThrow('checkpoint_invalid')
})

it.each([
  { displayStartSu: 1 },
  { rawStartSu: -1 },
  { rawEndSu: 100 },
  { rawEndSu: Number.MAX_SAFE_INTEGER + 1 },
  { rawEndSu: Number.NaN },
  { displayEndSu: 6 },
  { displayEndSu: 0 },
  { displayLengthSu: 4 },
  { emissionId: '' },
  { emissionId: 'x'.repeat(257) }
])('rejects invalid metadata %j', (changes) => {
  expect(() => advance(undefined, { ...emission, ...changes }, 8, 8)).toThrow('checkpoint_invalid')
})

it.each([
  [0, 0],
  [8, 6],
  [8, 7],
  [1.5, 2],
  [8, Infinity]
])('rejects invalid journal range %s:%s', (first, end) => {
  expect(() => advance(undefined, emission, first, end)).toThrow('checkpoint_invalid')
})

it('rejects raw gaps, overlaps and changed metadata under a reused emission identity', () => {
  const first = advance(undefined, emission, 8, 8)
  for (const rawStartSu of [111, 113]) {
    expect(() =>
      advance(first, { ...emission, emissionId: 'next', rawStartSu, rawEndSu: 120 }, 9, 9)
    ).toThrow('checkpoint_invalid')
  }
  expect(() => advance(first, { ...emission, rawStartSu: 112, rawEndSu: 120 }, 9, 9)).toThrow(
    'checkpoint_invalid'
  )
})

it('rejects incomplete predecessor, display overlap/gap and journal overlap/gap', () => {
  const first = advance(undefined, { ...emission, displayEndSu: 2 }, 8, 8)
  for (const changes of [
    { displayStartSu: 1 },
    { displayStartSu: 3 },
    { emissionId: 'other' },
    { rawEndSu: 113 },
    { displayLengthSu: 6 }
  ]) {
    expect(() => advance(first, { ...emission, displayStartSu: 2, ...changes }, 9, 9)).toThrow(
      'checkpoint_invalid'
    )
  }
  for (const seq of [8, 10]) {
    expect(() => advance(first, { ...emission, displayStartSu: 2 }, seq, seq)).toThrow(
      'checkpoint_invalid'
    )
  }
})
