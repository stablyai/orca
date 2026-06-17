import { describe, expect, it } from 'vitest'
import { canSubmitPrCompose, isBaseHeadDistinct } from './pr-compose-validation'

describe('isBaseHeadDistinct', () => {
  it('is true when base and head differ', () => {
    expect(isBaseHeadDistinct('main', 'feature')).toBe(true)
  })

  it('is false when they match after normalization (case-insensitive, prefix-stripped)', () => {
    expect(isBaseHeadDistinct('main', 'main')).toBe(false)
    expect(isBaseHeadDistinct('refs/heads/main', 'main')).toBe(false)
    expect(isBaseHeadDistinct('origin/Main', 'main')).toBe(false)
    expect(isBaseHeadDistinct('upstream/main', 'refs/heads/main')).toBe(false)
  })

  it('is false for an empty base', () => {
    expect(isBaseHeadDistinct('', 'feature')).toBe(false)
  })
})

describe('canSubmitPrCompose', () => {
  it('requires a non-empty title and a distinct base', () => {
    expect(canSubmitPrCompose('Title', 'main', 'feature')).toBe(true)
    expect(canSubmitPrCompose('   ', 'main', 'feature')).toBe(false)
    expect(canSubmitPrCompose('Title', 'main', 'main')).toBe(false)
  })
})
