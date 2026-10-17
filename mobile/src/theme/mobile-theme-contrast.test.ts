import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyMobileColorScheme,
  colors,
  darkColors,
  lightColors,
  onBrightColors
} from './mobile-theme'
import { styles as markdownStyles } from '../components/mobile-markdown-styles'
import { styles } from '../session/mobile-native-chat-message-styles'

vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
afterEach(() => applyMobileColorScheme('dark'))

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
  it.each(['light', 'dark'] as const)(
    'uses a %s surface and readable text for user image messages',
    (scheme) => {
      applyMobileColorScheme(scheme)
      expect(styles.userBubble.backgroundColor).toBe(colors.bgRaised)
      expect(
        contrastRatio(markdownStyles.paragraph.color, styles.userBubble.backgroundColor)
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(styles.imageRef.color, styles.userBubble.backgroundColor)
      ).toBeGreaterThanOrEqual(4.5)
    }
  )
  it.each([
    ['light', lightColors],
    ['dark', darkColors]
  ] as const)('keeps %s captions, prose and filled-action text readable', (_name, palette) => {
    for (const surface of [palette.bgBase, palette.bgPanel, palette.bgRaised]) {
      expect(contrastRatio(palette.textMuted, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(palette.textPrimary, surface)).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrastRatio(palette.onAccent, palette.accentBlue)).toBeGreaterThanOrEqual(3)
  })
  it.each([
    ['light', lightColors],
    ['dark', darkColors]
  ] as const)('keeps %s agent status indicators distinct from the surface', (_name, palette) => {
    for (const indicator of [palette.agentWorking, palette.agentDone, palette.agentAttention]) {
      for (const surface of [palette.bgBase, palette.bgPanel, palette.bgRaised]) {
        expect(contrastRatio(indicator, surface)).toBeGreaterThanOrEqual(3)
      }
    }
  })
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

  it.each(['dark', 'light'] as const)(
    'keeps inverted message colours readable in %s mode',
    (scheme) => {
      applyMobileColorScheme(scheme)
      for (const foreground of [colors.bgBase, onBrightColors.secondary, onBrightColors.link]) {
        expect(contrastRatio(foreground, colors.textPrimary)).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrastRatio(colors.bgBase, onBrightColors.codeBackground)).toBeGreaterThanOrEqual(
        4.5
      )
    }
  )
})
