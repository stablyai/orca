import { Platform } from 'react-native'
import { typography } from '../../../theme/mobile-theme'

export const optionPreviewFont = Platform.select({
  ios: 'Menlo',
  default: typography.monoFamily
})
