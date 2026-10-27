import { StyleSheet } from 'react-native'
import { typography } from '../theme/mobile-theme'
import { browserAddressFieldBase } from './browser-address-field-base-styles'

// Keep compact native meta size; web raises input/overlay label together to prevent iOS focus zoom without changing address size on focus.
const ADDRESS_FONT_SIZE = typography.metaSize

export const browserAddressFieldStyles = StyleSheet.create({
  input: { ...browserAddressFieldBase.input, fontSize: ADDRESS_FONT_SIZE, lineHeight: 16 },
  fileLabel: { ...browserAddressFieldBase.fileLabel, fontSize: ADDRESS_FONT_SIZE, lineHeight: 16 }
})
