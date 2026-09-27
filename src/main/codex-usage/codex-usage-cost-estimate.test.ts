import { describe, expect, it } from 'vitest'
import { estimateCostUsd, type CodexBillableTokens } from './codex-usage-cost-estimate'

function shortContext(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): CodexBillableTokens {
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    longContextInputTokens: 0,
    longContextCachedInputTokens: 0,
    longContextOutputTokens: 0
  }
}

function longContext(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): CodexBillableTokens {
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    longContextInputTokens: inputTokens,
    longContextCachedInputTokens: cachedInputTokens,
    longContextOutputTokens: outputTokens
  }
}

describe('estimateCostUsd', () => {
  it('bills a whole long-context request at the long-context rates', () => {
    // gpt-6-astra long rates $20 / $2 / $75: 0.15M*20 + 0.15M*2 + 0.1M*75.
    expect(estimateCostUsd('gpt-6-astra', longContext(300_000, 150_000, 100_000))).toBeCloseTo(
      10.8,
      9
    )
  })

  it('bills many short requests at base rates however large their sum', () => {
    // gpt-6-astra base $10 / $1 / $50: 2M*10 + 2M*1 + 0.2M*50.
    expect(estimateCostUsd('gpt-6-astra', shortContext(4_000_000, 2_000_000, 200_000))).toBeCloseTo(
      32,
      9
    )
  })

  it('bills the short remainder at base and the long subset at long rates', () => {
    const tokens: CodexBillableTokens = {
      inputTokens: 2_300_000,
      cachedInputTokens: 1_150_000,
      outputTokens: 200_000,
      longContextInputTokens: 300_000,
      longContextCachedInputTokens: 150_000,
      longContextOutputTokens: 100_000
    }
    // Short 1M uncached + 1M cached + 0.1M out = 16; long request = 10.8.
    expect(estimateCostUsd('gpt-6-astra', tokens)).toBeCloseTo(26.8, 9)
  })

  it('bills long-context tokens at base rates for models without a long-context tier', () => {
    // gpt-5.2-codex $1.75 / $0.175 / $14: 0.15M*1.75 + 0.15M*0.175 + 0.1M*14.
    expect(estimateCostUsd('gpt-5.2-codex', longContext(300_000, 150_000, 100_000))).toBeCloseTo(
      1.68875,
      9
    )
  })

  it('returns null for an unpriced model', () => {
    expect(estimateCostUsd('gpt-7-unreleased', shortContext(1, 0, 1))).toBeNull()
  })
})
