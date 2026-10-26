import { StyleSheet } from 'react-native'
import { TEXT_INPUT_FONT_SIZE } from '../../../platform/text-input-font-size'
import { mobileNativeChatInputBase } from './mobile-native-chat-input-base-styles'

// Keep inputs at the focus-zoom floor: iOS zoom would make keyboard geometry return zero for the rest of typing.
export const mobileNativeChatInputStyles = StyleSheet.create({
  input: { ...mobileNativeChatInputBase.input, fontSize: TEXT_INPUT_FONT_SIZE },
  freeInput: { ...mobileNativeChatInputBase.freeInput, fontSize: TEXT_INPUT_FONT_SIZE }
})
