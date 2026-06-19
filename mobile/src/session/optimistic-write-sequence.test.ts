import { describe, expect, it } from 'vitest'
import {
  createOptimisticField,
  isLatest,
  nextSeq,
  type OptimisticSeqRef
} from './optimistic-write-sequence'

describe('nextSeq / isLatest', () => {
  it('returns a monotonically increasing sequence', () => {
    const ref: OptimisticSeqRef = { current: 0 }
    expect(nextSeq(ref)).toBe(1)
    expect(nextSeq(ref)).toBe(2)
    expect(nextSeq(ref)).toBe(3)
    expect(ref.current).toBe(3)
  })

  it('isLatest is true only for the most recent sequence', () => {
    const ref: OptimisticSeqRef = { current: 0 }
    const a = nextSeq(ref)
    const b = nextSeq(ref)
    expect(isLatest(ref, a)).toBe(false)
    expect(isLatest(ref, b)).toBe(true)
  })
})

describe('OptimisticField — last-intent-wins', () => {
  it('renders optimistic when set, else authoritative', () => {
    const field = createOptimisticField<boolean>()
    expect(field.resolve(true)).toBe(true)
    const seq = field.begin(false)
    expect(field.resolve(true)).toBe(false)
    field.settleSuccess(seq)
    expect(field.resolve(true)).toBe(true)
  })

  it('two rapid writes A then B: A resolving after B must NOT win (B is latest)', () => {
    const field = createOptimisticField<boolean>()
    // authoritative = false
    const seqA = field.begin(true) // intent A: enable
    const seqB = field.begin(false) // intent B: disable (newer)
    expect(field.resolve(false)).toBe(false) // shows B's optimistic value

    // A's response arrives LATE and succeeds — it must not overwrite B.
    expect(field.settleSuccess(seqA)).toBe(false) // not applied (stale)
    expect(field.resolve(false)).toBe(false) // still B's optimistic value

    // B's response arrives and is the latest — clears optimism to authoritative.
    expect(field.settleSuccess(seqB)).toBe(true)
    expect(field.resolve(false)).toBe(false) // authoritative now
  })

  it('reverts only the latest write on failure', () => {
    const field = createOptimisticField<boolean>()
    const seqA = field.begin(true)
    const seqB = field.begin(false)
    expect(field.resolve(false)).toBe(false)

    // A fails late — it is not the latest, so it must NOT revert B's optimism.
    expect(field.settleFailure(seqA)).toBe(false)
    expect(field.resolve(false)).toBe(false) // B's optimistic value preserved

    // B fails as the latest — revert to authoritative (clear optimism).
    expect(field.settleFailure(seqB)).toBe(true)
    expect(field.resolve(false)).toBe(false) // authoritative shows through
  })

  it('a stale failure does not clear a newer optimistic value', () => {
    const field = createOptimisticField<string>()
    const seqOld = field.begin('old')
    field.begin('new')
    expect(field.resolve('auth')).toBe('new')
    expect(field.settleFailure(seqOld)).toBe(false)
    expect(field.resolve('auth')).toBe('new')
  })
})
