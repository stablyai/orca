import { describe, expect, it } from 'vitest'
import type { ClaudeUsageTokenTotals } from './types'
import { estimateCostUsd } from './claude-model-pricing'

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

function estimate(model: string, ...counts: number[]): number | null {
  return estimateCostUsd(model, tokens(...counts))
}

describe('estimateCostUsd cache-write TTL rates', () => {
  it('splits a mixed write bucket without double-billing the 1-hour share', () => {
    expect(estimate('claude-opus-5', 0, 0, 0, 1_000_000, 400_000)).toBeCloseTo(7.75)
  })
})

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
})

// Rate source: platform.claude.com/docs/en/about-claude/pricing.
