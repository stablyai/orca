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

import { browserAddressFieldStyles } from '../browser/browser-address-field-styles'
import { mobileBrowserPaneStyles } from '../browser/mobile-browser-pane-styles'
import { listStyles } from '../source-control/mobile-source-control-list-styles'
import { mobileDiffReviewControlStyles } from '../components/mobile-diff-review-control-styles'
import { customKeyModalStyles } from '../components/CustomKeyModal.styles'
import { mobileSessionCommandInputStyles } from '../session/mobile-session-command-input-styles'
import { typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from './text-input-font-size'
import {
  TEXT_INPUT_FONT_SIZE_FLOOR,
  TEXT_INPUT_FONT_SIZE as WEB_TEXT_INPUT_FONT_SIZE
} from './text-input-font-size.web'

/**
 * The size every page-served text input carries, on each platform.
 *
 * Both halves are asserted from here because a node test resolves the native sibling, so the web
 * value cannot be read off the style object: the bundler is what swaps the module, and that swap
 * is the overrides census's subject rather than this file's. What this file can hold is that the
 * two styles take their size from the seam at all, which is what makes the swap reach them.
 */
const MOBILE_ROOT = join(import.meta.dirname, '..', '..')
const STYLE_MODULES = [
  'src/source-control/mobile-source-control-list-styles.ts',
  'src/components/mobile-diff-review-control-styles.ts',
  'src/browser/mobile-browser-pane-styles.ts',
  // The session screen's six, which declare the app's body size and so need no sibling: the
  // native seam is that size, so the move is the same number and the swap is the whole change.
  'src/components/CustomKeyModal.styles.ts',
  'src/components/TextInputModal.tsx',
  'src/session/MobileNativeChatAsk.tsx',
  'src/session/QuickCommandEditorForm.tsx',
  'src/session/QuickCommandsList.tsx',
  'src/session/mobile-session-command-input-styles.ts'
]

/**
 * The inputs that reach the seam through a `.web.ts` sibling instead of directly.
 *
 * The browser pane's address bar renders at the theme's meta size natively, so it cannot take the
 * seam's value on both platforms the way the four above do. Its web half is where the raise lives,
 * and that is the file that has to carry the binding.
 */
const SPLIT_STYLE_MODULES = [
  'src/browser/browser-address-field-styles.web.ts',
  // The session screen's one: the chat's two fields sit at 15, under the floor and not the body
  // size, so they keep a native sibling. The custom-key capture field needed no split — 22 clears
  // the floor, and the census reads a literal that does as satisfying the rule (C7 ruling 12).
  'src/session/mobile-native-chat-input-styles.web.ts'
]

/** The seam's export, so the source check below looks for a binding rather than for a mention. */
const SEAM_EXPORT_NAME = 'TEXT_INPUT_FONT_SIZE'

describe('the font size the page-served text inputs carry', () => {
  it('clears the size iOS zooms the page for, on the web', () => {
    // Below the floor a focus zooms the document, and the keyboard seam reads a scale other than
    // 1 as no keyboard and stops lifting for the rest of the session. The number is the seam's
    // own, read rather than restated, because the census over every page route reads it too.
    expect(WEB_TEXT_INPUT_FONT_SIZE).toBeGreaterThanOrEqual(TEXT_INPUT_FONT_SIZE_FLOOR)
    expect(TEXT_INPUT_FONT_SIZE_FLOOR).toBe(16)
  })

  it('leaves a phone rendering exactly what it rendered before', () => {
    expect(TEXT_INPUT_FONT_SIZE).toBe(typography.bodySize)
    expect(listStyles.commitInput.fontSize).toBe(typography.bodySize)
    expect(mobileDiffReviewControlStyles.composerInput.fontSize).toBe(typography.bodySize)
    expect(mobileBrowserPaneStyles.keyboardInput.fontSize).toBe(typography.bodySize)
    expect(customKeyModalStyles.fieldInput.fontSize).toBe(typography.bodySize)
    // The capture field beside it, which is the one input on this screen no seam touches.
    expect(customKeyModalStyles.keyInput.fontSize).toBe(22)
    expect(customKeyModalStyles.keyInput.fontSize).toBeGreaterThanOrEqual(
      TEXT_INPUT_FONT_SIZE_FLOOR
    )
    expect(mobileSessionCommandInputStyles.textInput.fontSize).toBe(typography.bodySize)
    // The pane's address bar is the one that is split: it keeps the compact size natively, so the
    // seam reaches it through the `.web.ts` sibling rather than through this constant.
    expect(browserAddressFieldStyles.input.fontSize).toBe(typography.metaSize)
  })

  it('takes that size from the seam in every style, which is what the web build swaps', () => {
    // Read as source, and at the property rather than anywhere in the file: every one of these
    // modules resolves to the native constant here, so a style that went back to a literal 14 or
    // to `typography.bodySize` would pass every assertion above and ship 14px to the web. A
    // file-wide search would not see it either, because the import line survives the change.
    expect(
      [...STYLE_MODULES, ...SPLIT_STYLE_MODULES].filter(
        (module) =>
          !readFileSync(join(MOBILE_ROOT, module), 'utf8').includes(`fontSize: ${SEAM_EXPORT_NAME}`)
      )
    ).toEqual([])
  })
})
