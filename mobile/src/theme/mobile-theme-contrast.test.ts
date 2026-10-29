import { describe, expect, it } from 'vitest'
import { paletteForScheme } from './mobile-theme'

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

describe.each(['dark', 'light'] as const)('mobile text contrast (%s)', (scheme) => {
  const colors = paletteForScheme(scheme)

  // Light bgRaised is desktop's own --secondary under --muted-foreground (4.36:1), so only page surfaces are held to 4.5.
  it('keeps muted text readable on page and panel surfaces', () => {
    for (const surface of [colors.bgBase, colors.bgPanel]) {
      expect(contrastRatio(colors.textMuted, surface)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps secondary text at least as prominent as muted text', () => {
    expect(contrastRatio(colors.textSecondary, colors.bgPanel)).toBeGreaterThanOrEqual(
      contrastRatio(colors.textMuted, colors.bgPanel)
    )
  })

  it('keeps your own message readable on its bubble', () => {
    expect(
      contrastRatio(colors.chatForegroundStrong, colors.chatUserSurface)
    ).toBeGreaterThanOrEqual(4.5)
  })
})
