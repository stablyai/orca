import { describe, expect, it } from 'vitest'
import { IdleRegionalRehomeResponseSchema } from './idle-regional-rehome.js'

describe('idle regional rehome response', () => {
  it('reads a reason it does not know as absent instead of failing the response', () => {
    expect(
      IdleRegionalRehomeResponseSchema.parse({ v: 1, outcome: 'deferred', reason: 'from-a-newer-cell' })
    ).toEqual({ v: 1, outcome: 'deferred' })
  })
})
