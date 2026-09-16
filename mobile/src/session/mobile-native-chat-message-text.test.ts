import { describe, expect, it } from 'vitest'
import { clampFontScale, FONT_SCALE_MAX, FONT_SCALE_MIN } from './mobile-native-chat-message-text'

describe('clampFontScale', () => {
  it('clamps below the minimum', () => {
    expect(clampFontScale(0.1)).toBe(FONT_SCALE_MIN)
  })

  it('clamps above the maximum', () => {
    expect(clampFontScale(5)).toBe(FONT_SCALE_MAX)
  })

  it('passes through an in-range value', () => {
    expect(clampFontScale(1.2)).toBe(1.2)
  })

  it('falls back to 1 for NaN', () => {
    expect(clampFontScale(Number.NaN)).toBe(1)
  })
})
