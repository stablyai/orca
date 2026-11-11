import { describe, expect, it } from 'vitest'
import { IdleRegionalRehomeResponseSchema } from './idle-regional-rehome.js'

describe('idle regional rehome response', () => {
  it('accepts a source cell that has never heard of the reason field', () => {
    expect(IdleRegionalRehomeResponseSchema.parse({ v: 1, outcome: 'deferred' })).toEqual({
      v: 1,
      outcome: 'deferred'
    })
  })

  it('reads a reason it does not know as absent instead of failing the response', () => {
    expect(
      IdleRegionalRehomeResponseSchema.parse({ v: 1, outcome: 'deferred', reason: 'from-a-newer-cell' })
    ).toEqual({ v: 1, outcome: 'deferred' })
  })

  it('drops a field added after this decoder shipped', () => {
    expect(
      IdleRegionalRehomeResponseSchema.parse({ v: 1, outcome: 'committed', movedAt: 17 })
    ).toEqual({ v: 1, outcome: 'committed' })
  })
})
