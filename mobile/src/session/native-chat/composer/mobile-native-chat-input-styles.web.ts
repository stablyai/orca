import { TEXT_INPUT_FONT_SIZE } from '../../../platform/text-input-font-size'
import { mobileNativeChatInputBase } from './mobile-native-chat-input-base-styles'
import { themedStyleSheet } from '../../../theme/themed-styles'

// Keep inputs at the focus-zoom floor: iOS zoom would make keyboard geometry return zero for the rest of typing.
export const mobileNativeChatInputStyles = themedStyleSheet(() => ({
  input: { ...mobileNativeChatInputBase.input, fontSize: TEXT_INPUT_FONT_SIZE },
  freeInput: { ...mobileNativeChatInputBase.freeInput, fontSize: TEXT_INPUT_FONT_SIZE }
}))
