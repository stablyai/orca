import { describe, expect, it } from 'vitest'
import { colors } from './mobile-theme'

function channelLuminance(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(hex: string): number {
  const red = Number.parseInt(hex.slice(1, 3), 16)
  const green = Number.parseInt(hex.slice(3, 5), 16)
  const blue = Number.parseInt(hex.slice(5, 7), 16)
  return (
    0.2126 * channelLuminance(red) +
    0.7152 * channelLuminance(green) +
    0.0722 * channelLuminance(blue)
  )
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('mobile text contrast', () => {
  it('keeps muted text readable on every standard dark surface', () => {
    for (const surface of [colors.bgBase, colors.bgPanel, colors.bgRaised]) {
      expect(contrastRatio(colors.textMuted, surface)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps secondary text more prominent than muted text', () => {
    expect(contrastRatio(colors.textSecondary, colors.bgPanel)).toBeGreaterThan(
      contrastRatio(colors.textMuted, colors.bgPanel)
    )
  })
})
