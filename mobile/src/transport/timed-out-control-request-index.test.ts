import { describe, expect, it } from 'vitest'
import { TimedOutControlRequestIndex } from './timed-out-control-request-index'

describe('TimedOutControlRequestIndex', () => {
  it('retains evidence until its bounded expiry', () => {
    let now = 100
    const index = new TimedOutControlRequestIndex(() => now, 50)
    index.remember('late')

    now = 149
    expect(index.consume('late')).toBe(true)
    index.remember('expired')
    now = 200
    expect(index.consume('expired')).toBe(false)
  })

  it('evicts the oldest evidence at the per-connection limit', () => {
    const index = new TimedOutControlRequestIndex(() => 0, 100, 2)
    index.remember('first')
    index.remember('second')
    index.remember('third')

    expect(index.consume('first')).toBe(false)
    expect(index.consume('second')).toBe(true)
    expect(index.consume('third')).toBe(true)
  })
})
