import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToRgb, mix, rgbaToHex } from '../../../../shared/color/rgba-contrast'
import {
  NOTICE_DESCRIPTION_TOKEN,
  NOTICE_SURFACE_TOKEN,
  noticeSurfaceTokensFor
} from './notice-surface-tokens'

const ratio = (a: string, b: string): number => contrastRatio(hexToRgb(a), hexToRgb(b))
const blend80 = (text: string, surface: string): string =>
  rgbaToHex(mix(hexToRgb(text), hexToRgb(surface), 80))

describe('noticeSurfaceTokensFor', () => {
  it('lifts a dark popover 15% toward the foreground so notices stand off the canvas', () => {
    const tokens = noticeSurfaceTokensFor(
      {
        foreground: hexToRgb('#f0f0f0'),
        popover: hexToRgb('#171717'),
        popoverForeground: hexToRgb('#f0f0f0'),
        mutedForeground: hexToRgb('#acacac')
      },
      'dark'
    )
    expect(tokens[NOTICE_SURFACE_TOKEN]).toBe('#383838')
    expect(ratio(tokens[NOTICE_SURFACE_TOKEN], '#1e1e1e')).toBeGreaterThanOrEqual(1.4)
    // Room to spare: the description keeps its quieter 80% blend.
    expect(tokens[NOTICE_DESCRIPTION_TOKEN]).toBe(blend80('#f0f0f0', '#383838'))
  })

  it('keeps the full dark lift and raises the description when the 80% blend would not read', () => {
    const tokens = noticeSurfaceTokensFor(
      {
        foreground: hexToRgb('#f0f0f0'),
        popover: hexToRgb('#181818'),
        popoverForeground: hexToRgb('#a4a4a4'),
        mutedForeground: hexToRgb('#a4a4a4')
      },
      'dark'
    )
    const surface = tokens[NOTICE_SURFACE_TOKEN]
    expect(surface).toBe('#383838')
    expect(ratio(surface, blend80('#a4a4a4', surface))).toBeLessThan(4.5)
    expect(ratio(surface, tokens[NOTICE_DESCRIPTION_TOKEN])).toBeGreaterThanOrEqual(4.5)
  })

  it('raises the description toward full popover text when 80% would read below 4.5:1', () => {
    const tokens = noticeSurfaceTokensFor(
      {
        foreground: hexToRgb('#1a1a1a'),
        popover: hexToRgb('#ffffff'),
        popoverForeground: hexToRgb('#6e6e6e'),
        mutedForeground: hexToRgb('#6e6e6e')
      },
      'light'
    )
    const surface = tokens[NOTICE_SURFACE_TOKEN]
    expect(surface).toBe('#ffffff')
    expect(ratio(surface, blend80('#6e6e6e', surface))).toBeLessThan(4.5)
    expect(ratio(surface, tokens[NOTICE_DESCRIPTION_TOKEN])).toBeGreaterThanOrEqual(4.5)
  })

  it('leaves translucent popovers to the CSS defaults', () => {
    expect(
      noticeSurfaceTokensFor(
        {
          foreground: hexToRgb('#f0f0f0'),
          popover: [36, 40, 56, 0.72],
          popoverForeground: hexToRgb('#e8eaf2'),
          mutedForeground: hexToRgb('#acacac')
        },
        'dark'
      )
    ).toEqual({})
  })
})
