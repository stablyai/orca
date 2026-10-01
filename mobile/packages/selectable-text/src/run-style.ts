import { StyleSheet, type StyleProp, type TextStyle } from 'react-native'
import type { NativeFontWeight } from './OrcaSelectableTextRunNativeComponent'

export type RunStyle = Omit<TextStyle, 'fontWeight'> & { fontWeight: NativeFontWeight }

/** Nested text inherits its parent's style, like React Native's own Text. */
export function inheritTextStyle(parent: TextStyle, style: StyleProp<TextStyle>): TextStyle {
  return StyleSheet.flatten([parent, style])
}

export function toRunStyle(style: TextStyle): RunStyle {
  return {
    ...style,
    fontWeight: toNativeFontWeight(style.fontWeight ?? 'normal'),
    backgroundColor: style.backgroundColor ?? 'transparent',
    shadowOffset: style.shadowOffset ?? { width: 0, height: 0 }
  }
}

// Codegen enums can't be numeric, so map CSS weights onto the native names.
function toNativeFontWeight(fontWeight: NonNullable<TextStyle['fontWeight']>): NativeFontWeight {
  switch (fontWeight) {
    case 'bold':
    case 700:
    case '700':
    case 800:
    case '800':
      return 'bold'
    case 100:
    case '100':
    case 'ultralight':
    case 200:
    case '200':
      return 'ultraLight'
    case 300:
    case '300':
    case 'light':
      return 'light'
    case 500:
    case '500':
    case 'medium':
      return 'medium'
    case 600:
    case '600':
    case 'semibold':
      return 'semibold'
    case 900:
    case '900':
    case 'heavy':
      return 'heavy'
    default:
      return 'normal'
  }
}
