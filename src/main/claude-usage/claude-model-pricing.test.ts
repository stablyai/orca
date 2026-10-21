import { describe, expect, it } from 'vitest'
import type { ClaudeUsageTokenTotals } from './types'
import { MODEL_PRICING, estimateCostUsd, normalizeModelForPricing } from './claude-model-pricing'

const MTOK = 1_000_000

function tokens(
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  cacheWrite1hTokens = 0
): ClaudeUsageTokenTotals {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens }
}

/** Prices plain totals, none of them from a long-context request. */
function estimate(model: string, ...counts: number[]): number | null {
  return estimateCostUsd(model, tokens(...counts))
}

describe('model pricing name matching', () => {
  it.each(Object.keys(MODEL_PRICING))('resolves the table key %s to its own row', (key) => {
    expect(normalizeModelForPricing(key)).toBe(key)
  })

  it.each([
    [' ANTHROPIC/claude-opus-4.1-thinking ', 'claude-opus-4-1'],
    ['claude-opus-4-20250514', 'claude-opus-4'],
    ['claude-opus-4.20250514', 'claude-opus-4'],
    ['claude-opus-4@20250514', 'claude-opus-4'],
    ['claude-opus-4-5@20251101', 'claude-opus-4-5'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
    ['claude-sonnet-5-thinking', 'claude-sonnet-5'],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
    ['claude-sonnet-5.5[1m]', 'claude-sonnet-5-5'],
    ['claude-opus-5.5[1m]', 'claude-opus-5-5'],
    ['claude-opus-5-5-thinking', 'claude-opus-5-5'],
    ['claude-fable-5-1[1m]', 'claude-fable-5-1'],
    ['claude-fable-5-1m', 'claude-fable-5'],
    ['claude-opus-4.8-thinking', 'claude-opus-4-8'],
    ['claude-3-5-sonnet-20241022', 'claude-sonnet-3-5'],
    ['claude-3.5-sonnet', 'claude-sonnet-3-5'],
    ['claude-3-7-sonnet-20250219', 'claude-sonnet-3-7'],
    ['claude-3-5-haiku-20241022', 'claude-haiku-3-5'],
    ['claude-3-haiku-20240307', 'claude-haiku-3'],
    ['claude-4.5-sonnet-thinking', 'claude-sonnet-4-5'],
    ['model_placeholder_m26', 'claude-opus-4-6']
  ])('reads the family and version out of %s', (model, key) => {
    expect(normalizeModelForPricing(model)).toBe(key)
  })

  // Why: an unknown version must stay unpriced (and flagged), never borrow an older model's rates.
  it.each([
    'claude-opus-5-6',
    'claude-sonnet-5-6',
    'claude-fable-5-2',
    'claude-opus-6',
    'claude-opus-4.9',
    'claude-opus-5-50',
    'claude-sonnet-50',
    'claude-3-opus-20240229',
    'sonnet',
    'gpt-5'
  ])('leaves %s unpriced', (model) => {
    expect(normalizeModelForPricing(model)).toBeNull()
  })
})

describe('point-release rates that differ from their major', () => {
  it('bills Opus 5.5 below Opus 5 across every bucket', () => {
    expect(estimate('claude-opus-5-5', 1_000_000, 1_000_000, 1_000_000, 0)).toBeCloseTo(24.2)
    expect(estimate('claude-opus-5-5', 0, 0, 0, 1_000_000, 400_000)).toBeCloseTo(6.2)
  })

  it('bills Sonnet 5.5 cache reads at half of Sonnet 5', () => {
    expect(estimate('claude-sonnet-5-5', 0, 0, 1_000_000, 0)).toBeCloseTo(0.1)
    expect(estimate('claude-sonnet-5-5', 1_000_000, 1_000_000, 0, 1_000_000, 0)).toBeCloseTo(14.5)
    expect(estimate('claude-sonnet-5-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(4)
  })

  it('bills Fable 5.1 cache reads at a quarter of Fable 5', () => {
    expect(estimate('claude-fable-5-1', 0, 0, 1_000_000, 0)).toBeCloseTo(0.25)
    expect(estimate('claude-fable-5', 0, 0, 1_000_000, 0)).toBeCloseTo(1)
    expect(estimate('claude-fable-5-1m', 0, 0, 1_000_000, 0)).toBeCloseTo(1)
  })
})

describe('estimateCostUsd cache-write TTL rates', () => {
  it('bills 5-minute cache writes at 1.25x base input', () => {
    expect(estimate('claude-opus-5', 0, 0, 0, 1_000_000, 0)).toBeCloseTo(6.25)
  })

  it('bills 1-hour cache writes at 2x base input', () => {
    expect(estimate('claude-opus-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(10)
  })

  it('splits a mixed write bucket without double-billing the 1-hour share', () => {
    expect(estimate('claude-opus-5', 0, 0, 0, 1_000_000, 400_000)).toBeCloseTo(7.75)
  })

  it('clamps a 1-hour count that exceeds the reported write total', () => {
    expect(estimate('claude-opus-5', 0, 0, 0, 1_000, 5_000)).toBeCloseTo(0.01)
  })

  it('keeps Sonnet 4.6 one-hour writes flat across its full 1M window', () => {
    expect(estimate('claude-sonnet-4-6', 0, 0, 0, 400_000, 400_000)).toBeCloseTo(2.4)
  })

  it('still returns null for unknown models', () => {
    expect(estimate('gpt-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeNull()
  })
})

// A request over the threshold is billed entirely at long-context rates; callers pass that subset.
describe('estimateCostUsd long-context requests', () => {
  it('bills only the long-context subset at Haiku 5.5 long-context rates', () => {
    const short = tokens(MTOK, MTOK, MTOK, MTOK, 400_000)
    expect(estimateCostUsd('claude-haiku-5-5', short)).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.075 + 0.08)
    expect(estimateCostUsd('claude-haiku-5-5', { ...short, longContext: short })).toBeCloseTo(
      0.5 + 2.5 + 0.05 + 0.375 + 0.4
    )
    expect(
      estimateCostUsd('claude-haiku-5-5', {
        ...tokens(2 * MTOK),
        longContext: tokens(MTOK)
      })
    ).toBeCloseTo(0.1 + 0.5)
  })

  it('bills Sonnet 4.5 long-context requests at its premium rates', () => {
    const long = tokens(MTOK, MTOK, MTOK, MTOK, MTOK)
    expect(estimateCostUsd('claude-sonnet-4-5', { ...long, longContext: long })).toBeCloseTo(
      6 + 22.5 + 0.6 + 12
    )
    // Daily totals far over 200K from short requests stay at base rates.
    expect(estimate('claude-sonnet-4-5', 5 * MTOK)).toBeCloseTo(15)
  })

  it('ignores a long-context subset for a model with flat rates', () => {
    const long = tokens(MTOK)
    expect(estimateCostUsd('claude-sonnet-4-6', { ...long, longContext: long })).toBeCloseTo(3)
  })

  it('clamps a long-context subset larger than its totals', () => {
    expect(
      estimateCostUsd('claude-haiku-5-5', { ...tokens(MTOK), longContext: tokens(3 * MTOK) })
    ).toBeCloseTo(0.5)
  })
})

// Published Claude Sonnet 5 rates (platform.claude.com/docs/en/about-claude/pricing):
// $2 base input, $10 output, $0.20 cache hit, $2.50 5m write, $4 1h write per MTok.
// The $2/$10 launch price, announced as introductory through 2026-08-31, is now the
// standard price — the scheduled 2026-09-01 rise to $3/$15 was cancelled — so the rate
// is date-independent.
describe('estimateCostUsd Claude Sonnet 5 rates', () => {
  it('bills base input at $2/MTok', () => {
    expect(estimate('claude-sonnet-5', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(2)
  })

  it('bills output at $10/MTok', () => {
    expect(estimate('claude-sonnet-5', 0, 1_000_000, 0, 0, 0)).toBeCloseTo(10)
  })

  it('bills cache hits at $0.20/MTok', () => {
    expect(estimate('claude-sonnet-5', 0, 0, 1_000_000, 0, 0)).toBeCloseTo(0.2)
  })

  it('bills 5-minute cache writes at $2.50/MTok and 1-hour writes at $4/MTok', () => {
    expect(estimate('claude-sonnet-5', 0, 0, 0, 1_000_000, 0)).toBeCloseTo(2.5)
    expect(estimate('claude-sonnet-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(4)
  })

  it('keeps the full 1M window at flat rates with no long-context tier', () => {
    expect(estimate('claude-sonnet-5', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(
      estimate('claude-sonnet-5', 500_000, 0, 0, 0, 0)! * 2
    )
  })
})
