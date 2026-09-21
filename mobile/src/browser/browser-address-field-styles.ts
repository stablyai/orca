import { StyleSheet } from 'react-native'
import { typography } from '../theme/mobile-theme'
import { browserAddressFieldBase } from './browser-address-field-base-styles'

/**
 * Native: the address bar is a compact control and carries the theme's meta size, which is what it
 * has always rendered at.
 *
 * The `.web.ts` sibling raises it, because in a browser an input under 16px zooms the page on focus
 * and the page's keyboard seam reads that zoom as "no keyboard". The label and the input move
 * together: the label is painted over the field whenever it is not focused, so a size that differed
 * would resize the address on every focus.
 */
const ADDRESS_FONT_SIZE = typography.metaSize

export const browserAddressFieldStyles = StyleSheet.create({
  input: { ...browserAddressFieldBase.input, fontSize: ADDRESS_FONT_SIZE, lineHeight: 16 },
  fileLabel: { ...browserAddressFieldBase.fileLabel, fontSize: ADDRESS_FONT_SIZE, lineHeight: 16 }
})
