import { describe, expect, it } from 'vitest'
import { estimateCostUsd } from './claude-model-pricing'

describe('estimateCostUsd cache-write TTL rates', () => {
  it('bills 5-minute cache writes at 1.25x base input', () => {
    expect(estimateCostUsd('claude-opus-5', 0, 0, 0, 1_000_000, 0)).toBeCloseTo(6.25)
  })

  it('keeps the legacy five-argument call billing every write at the 5-minute rate', () => {
    expect(estimateCostUsd('claude-opus-5', 0, 0, 0, 1_000_000)).toBeCloseTo(6.25)
  })

  it('bills 1-hour cache writes at 2x base input', () => {
    expect(estimateCostUsd('claude-opus-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(10)
  })

  it('splits a mixed write bucket without double-billing the 1-hour share', () => {
    expect(estimateCostUsd('claude-opus-5', 0, 0, 0, 1_000_000, 400_000)).toBeCloseTo(7.75)
  })

  it('clamps a 1-hour count that exceeds the reported write total', () => {
    expect(estimateCostUsd('claude-opus-5', 0, 0, 0, 1_000, 5_000)).toBeCloseTo(0.01)
  })

  it('keeps Sonnet 4.6 one-hour writes flat across its full 1M window', () => {
    expect(estimateCostUsd('claude-sonnet-4-6', 0, 0, 0, 400_000, 400_000)).toBeCloseTo(2.4)
  })

  it('applies the legacy long-context tier to Sonnet 4.5 one-hour writes', () => {
    expect(estimateCostUsd('claude-sonnet-4-5', 0, 0, 0, 400_000, 400_000)).toBeCloseTo(3.6)
  })

  it('shares one legacy long-context allowance across both TTL buckets', () => {
    // 400k writes split evenly: 200k @ (3.75/7.5) and 200k @ (6/12), each tier
    // getting half of the 200k allowance.
    expect(estimateCostUsd('claude-sonnet-4-5', 0, 0, 0, 400_000, 200_000)).toBeCloseTo(2.925)
  })

  it('never lowers a legacy long-context estimate as writes shift to 1-hour', () => {
    const costs = [0, 50_000, 100_000, 200_000, 300_000, 400_000].map((write1h) =>
      estimateCostUsd('claude-sonnet-4-5', 0, 0, 0, 400_000, write1h)!
    )
    for (let index = 1; index < costs.length; index++) {
      expect(costs[index]).toBeGreaterThan(costs[index - 1])
    }
  })

  it('still returns null for unknown models', () => {
    expect(estimateCostUsd('gpt-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeNull()
  })
})

// Published Claude Sonnet 5 rates (platform.claude.com/docs/en/about-claude/pricing):
// $2 base input, $10 output, $0.20 cache hit, $2.50 5m write, $4 1h write per MTok.
// The $2/$10 launch price, announced as introductory through 2026-08-31, is now the
// standard price — the scheduled 2026-09-01 rise to $3/$15 was cancelled — so the rate
// is date-independent.
describe('estimateCostUsd Claude Sonnet 5 rates', () => {
  it('bills base input at $2/MTok', () => {
    expect(estimateCostUsd('claude-sonnet-5', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(2)
  })

  it('bills output at $10/MTok', () => {
    expect(estimateCostUsd('claude-sonnet-5', 0, 1_000_000, 0, 0, 0)).toBeCloseTo(10)
  })

  it('bills cache hits at $0.20/MTok', () => {
    expect(estimateCostUsd('claude-sonnet-5', 0, 0, 1_000_000, 0, 0)).toBeCloseTo(0.2)
  })

  it('bills 5-minute cache writes at $2.50/MTok and 1-hour writes at $4/MTok', () => {
    expect(estimateCostUsd('claude-sonnet-5', 0, 0, 0, 1_000_000, 0)).toBeCloseTo(2.5)
    expect(estimateCostUsd('claude-sonnet-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(4)
  })

  it('keeps the full 1M window at flat rates with no long-context tier', () => {
    expect(estimateCostUsd('claude-sonnet-5', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(
      estimateCostUsd('claude-sonnet-5', 500_000, 0, 0, 0, 0)! * 2
    )
  })
})
