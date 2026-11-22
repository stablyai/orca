import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToRgb } from '../../../../shared/color/rgba-contrast'
import {
  NOTICE_DESCRIPTION_TOKEN,
  NOTICE_SURFACE_TOKEN,
  noticeSurfaceTokensFor
} from './notice-surface-tokens'

const ratio = (a: string, b: string): number => contrastRatio(hexToRgb(a), hexToRgb(b))

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
    expect(tokens[NOTICE_DESCRIPTION_TOKEN]).toBe('#cbcbcb')
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
    const description = tokens[NOTICE_DESCRIPTION_TOKEN]
    expect(surface).toBe('#ffffff')
    expect(ratio('#ffffff', '#8b8b8b')).toBeLessThan(4.5) // the 80% blend this replaces
    expect(ratio(surface, description)).toBeGreaterThanOrEqual(4.5)
  })
})
