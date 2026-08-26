import { describe, expect, it } from 'vitest'
import { normalizeModelForPricing } from './codex-model-pricing'

describe('normalizeModelForPricing', () => {
  it('strips the max and ultra reasoning tiers Codex 0.147 introduced', () => {
    expect(normalizeModelForPricing('gpt-5.6-sol-ultra')).toBe('gpt-5.6-sol')
    expect(normalizeModelForPricing('gpt-5.6-sol(ultra)')).toBe('gpt-5.6-sol')
    expect(normalizeModelForPricing('gpt-5.6-luna-max')).toBe('gpt-5.6-luna')
    expect(normalizeModelForPricing('gpt-5.6-luna(max)')).toBe('gpt-5.6-luna')
  })

  it('keeps gpt-5.1-codex-max a family name rather than a stripped reasoning tier', () => {
    expect(normalizeModelForPricing('gpt-5.1-codex-max')).toBe('gpt-5.1-codex-max')
    expect(normalizeModelForPricing('gpt-5.1-codex-max-xhigh')).toBe('gpt-5.1-codex-max')
    expect(normalizeModelForPricing('gpt-5.1-codex-max(high)')).toBe('gpt-5.1-codex-max')
    expect(normalizeModelForPricing('gpt-5.1-codex-high')).toBe('gpt-5.1-codex')
  })

  it('still rejects a parenthesized suffix that is not a reasoning tier', () => {
    expect(normalizeModelForPricing('gpt-5.5(preview)')).toBe(null)
  })
})
