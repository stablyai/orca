import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The stylesheets are the subject, so react-native is stubbed down to what they touch rather than
// parsed: its entry point is Flow, which this runner does not read.
vi.mock('react-native', () => ({
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1
  }
}))

import { listStyles } from '../source-control/mobile-source-control-list-styles'
import { mobileDiffReviewControlStyles } from '../components/mobile-diff-review-control-styles'
import { typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from './text-input-font-size'
import { TEXT_INPUT_FONT_SIZE as WEB_TEXT_INPUT_FONT_SIZE } from './text-input-font-size.web'

/**
 * The size the two page-served text inputs carry, on each platform.
 *
 * Both halves are asserted from here because a node test resolves the native sibling, so the web
 * value cannot be read off the style object: the bundler is what swaps the module, and that swap
 * is the overrides census's subject rather than this file's. What this file can hold is that the
 * two styles take their size from the seam at all, which is what makes the swap reach them.
 */
const MOBILE_ROOT = join(import.meta.dirname, '..', '..')
const STYLE_MODULES = [
  'src/source-control/mobile-source-control-list-styles.ts',
  'src/components/mobile-diff-review-control-styles.ts'
]

describe('the font size the page-served text inputs carry', () => {
  it('clears the size iOS zooms the page for, on the web', () => {
    // 16 is the floor; below it a focus zooms the document and the keyboard seam, which reads a
    // scale other than 1 as no keyboard, stops lifting for the rest of the session.
    expect(WEB_TEXT_INPUT_FONT_SIZE).toBeGreaterThanOrEqual(16)
  })

  it('leaves a phone rendering exactly what it rendered before', () => {
    expect(TEXT_INPUT_FONT_SIZE).toBe(typography.bodySize)
    expect(listStyles.commitInput.fontSize).toBe(typography.bodySize)
    expect(mobileDiffReviewControlStyles.composerInput.fontSize).toBe(typography.bodySize)
  })

  it('takes that size from the seam in both styles, which is what the web build swaps', () => {
    // Read as source: both modules resolve to the native constant here, so a style that went back
    // to `typography.bodySize` would pass every assertion above and ship 14px to the web.
    expect(
      STYLE_MODULES.filter(
        (module) =>
          !readFileSync(join(MOBILE_ROOT, module), 'utf8').includes('TEXT_INPUT_FONT_SIZE')
      )
    ).toEqual([])
  })
})
