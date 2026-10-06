import { StyleSheet } from 'react-native'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { browserAddressFieldBase } from './browser-address-field-base-styles'

/**
 * Web sibling: the address input goes on the text-input seam, which holds it at or above the size
 * below which iOS zooms the page on focus.
 *
 * That zoom is not cosmetic here. `keyboard-occlusion.web.ts` reads a visual viewport scale other
 * than 1 as "not a keyboard" and answers 0, so one focus of a 12px address bar would leave the
 * pane's keyboard lift at 0 for the rest of the typing session — C4.2's failure, on a screen its
 * census does not yet walk.
 *
 * The line height follows the size rather than staying at the native 16, which would clip a 16px
 * glyph, and the file label follows both so the address does not resize as focus moves.
 */
const ADDRESS_LINE_HEIGHT = TEXT_INPUT_FONT_SIZE + 4

export const browserAddressFieldStyles = StyleSheet.create({
  input: {
    ...browserAddressFieldBase.input,
    fontSize: TEXT_INPUT_FONT_SIZE,
    lineHeight: ADDRESS_LINE_HEIGHT
  },
  fileLabel: {
    ...browserAddressFieldBase.fileLabel,
    fontSize: TEXT_INPUT_FONT_SIZE,
    lineHeight: ADDRESS_LINE_HEIGHT
  }
})
