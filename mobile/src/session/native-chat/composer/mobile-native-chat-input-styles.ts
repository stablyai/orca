import { StyleSheet } from 'react-native'
import { typography } from '../../../theme/mobile-theme'
import { mobileNativeChatInputBase } from './mobile-native-chat-input-base-styles'

// Native sizes need no zoom guard; the web sibling applies the iOS focus-zoom floor.
const CHAT_INPUT_FONT_SIZE = typography.bodySize + 1
const COMPOSER_INPUT_FONT_SIZE = 16

export const mobileNativeChatInputStyles = StyleSheet.create({
  input: { ...mobileNativeChatInputBase.input, fontSize: COMPOSER_INPUT_FONT_SIZE },
  freeInput: { ...mobileNativeChatInputBase.freeInput, fontSize: CHAT_INPUT_FONT_SIZE }
})
