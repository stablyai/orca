import { describe, expect, it } from 'vitest'
import { createOptimisticField } from './optimistic-write-sequence'

describe('OptimisticField — last-intent-wins', () => {
  it('reverts only the latest write on failure', () => {
    const field = createOptimisticField<boolean>()
    const seqA = field.begin(true)
    const seqB = field.begin(false)
    expect(field.resolve(false)).toBe(false)

    expect(field.settleFailure(seqA)).toBe(false)
    expect(field.resolve(false)).toBe(false)

    expect(field.settleFailure(seqB)).toBe(true)
    expect(field.resolve(true)).toBe(true)
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
