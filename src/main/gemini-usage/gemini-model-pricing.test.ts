import { describe, expect, it } from 'vitest'
import { MODEL_PRICING, normalizeModelForPricing } from './gemini-model-pricing'

describe('gemini-model-pricing', () => {
  it('normalizes standard gemini pro models and variants', () => {
    expect(normalizeModelForPricing('gemini-2.5-pro')).toBe('gemini-2.5-pro')
    expect(normalizeModelForPricing('gemini-3.0-pro')).toBe('gemini-3.0-pro')
    expect(normalizeModelForPricing('gemini-3.1-pro')).toBe('gemini-3.1-pro')
    expect(normalizeModelForPricing('gemini-1.5-pro')).toBe('gemini-1.5-pro')
    expect(normalizeModelForPricing('gemini-pro')).toBe('gemini-2.5-pro')
    expect(normalizeModelForPricing('google/gemini-2.5-pro')).toBe('gemini-2.5-pro')
    expect(normalizeModelForPricing('models/gemini-2.5-pro-preview')).toBe('gemini-2.5-pro')
    expect(normalizeModelForPricing('google-antigravity/gemini-3-pro-preview')).toBe(
      'gemini-3-pro-preview'
    )
  })

  it('normalizes gemini flash and flash-lite models', () => {
    expect(normalizeModelForPricing('gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(normalizeModelForPricing('gemini-3.0-flash')).toBe('gemini-3.0-flash')
    expect(normalizeModelForPricing('gemini-3.1-flash')).toBe('gemini-3.1-flash')
    expect(normalizeModelForPricing('gemini-2.5-flash-lite')).toBe('gemini-2.5-flash-lite')
    expect(normalizeModelForPricing('gemini-2.0-flash-lite')).toBe('gemini-2.0-flash-lite')
    expect(normalizeModelForPricing('gemini-flash')).toBe('gemini-2.5-flash')
    expect(normalizeModelForPricing('gemini-2.5-flash-thinking')).toBe('gemini-2.5-flash')
  })

  it('normalizes experimental, ultra, and dated model tags', () => {
    expect(normalizeModelForPricing('gemini-exp')).toBe('gemini-exp')
    expect(normalizeModelForPricing('gemini-experimental')).toBe('gemini-experimental')
    expect(normalizeModelForPricing('gemini-ultra')).toBe('gemini-ultra')
    expect(normalizeModelForPricing('gemini-1.5-pro-002')).toBe('gemini-1.5-pro')
    expect(normalizeModelForPricing('gemini-2.5-pro-20260501')).toBe('gemini-2.5-pro')
  })

  it('returns null for unknown or null models', () => {
    expect(normalizeModelForPricing(null)).toBeNull()
    expect(normalizeModelForPricing('')).toBeNull()
    expect(normalizeModelForPricing('claude-sonnet-4-5')).toBeNull()
    expect(normalizeModelForPricing('custom-pro-model')).toBeNull()
    expect(normalizeModelForPricing('custom-flash')).toBeNull()
    expect(normalizeModelForPricing('gpt-5.4')).toBeNull()
  })

  it('has pricing defined for all canonical normalized model targets', () => {
    for (const key of Object.keys(MODEL_PRICING)) {
      const pricing = MODEL_PRICING[key]
      expect(pricing).toBeDefined()
      expect(pricing.input).toBeGreaterThan(0)
      expect(pricing.cachedInput).toBeGreaterThan(0)
      expect(pricing.output).toBeGreaterThan(0)
    }
  })
})
