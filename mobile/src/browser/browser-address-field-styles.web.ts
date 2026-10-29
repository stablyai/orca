import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { themedStyleSheet } from '../theme/themed-styles'
import { browserAddressFieldBase } from './browser-address-field-base-styles'

// Use web text-input seam (>=16px): iOS focus zoom otherwise makes keyboard-occlusion read zero for whole typing session.
// Raise line height and overlay label with input to prevent clipping and focus-time text resize.
const ADDRESS_LINE_HEIGHT = TEXT_INPUT_FONT_SIZE + 4

export const browserAddressFieldStyles = themedStyleSheet(() => ({
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
}))
