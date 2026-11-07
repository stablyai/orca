import { describe, expect, it } from 'vitest'
import {
  IDLE_REGIONAL_REHOME_DEFER_REASONS,
  IdleRegionalRehomeResponseSchema,
  isGlobalIdleRegionalRehomeDeferral
} from './idle-regional-rehome.js'

describe('idle regional rehome response', () => {
  it('accepts a source cell that has never heard of the reason field', () => {
    expect(IdleRegionalRehomeResponseSchema.parse({ v: 1, outcome: 'deferred' })).toEqual({
      v: 1,
      outcome: 'deferred'
    })
  })

  it('carries every reason the source can send', () => {
    for (const reason of IDLE_REGIONAL_REHOME_DEFER_REASONS) {
      expect(
        IdleRegionalRehomeResponseSchema.parse({ v: 1, outcome: 'deferred', reason })
      ).toEqual({ v: 1, outcome: 'deferred', reason })
    }
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

  it('still rejects an outcome it cannot act on', () => {
    expect(() => IdleRegionalRehomeResponseSchema.parse({ v: 1, outcome: 'moved' })).toThrow()
  })

  it('classifies only the poll-wide deferrals as global', () => {
    for (const [reason, expected] of [
      ['control-closed', true],
      ['budget-closed', true],
      ['concurrency-limit', true],
      ['cohort-closed', true],
      ['fleet-safety', true],
      ['candidate-ineligible', false],
      ['host-unsupported', false],
      ['director-safety-stale', false],
      [undefined, false]
    ] as const) {
      expect(isGlobalIdleRegionalRehomeDeferral(reason), reason).toBe(expected)
    }
  })
})
