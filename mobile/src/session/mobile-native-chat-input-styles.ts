import { StyleSheet } from 'react-native'
import { mobileNativeChatInputBase } from './mobile-native-chat-input-base-styles'

/** Native: the composer reads at 16, the size the page's floor already gives it. */
const COMPOSER_INPUT_FONT_SIZE = 16

export const mobileNativeChatInputStyles = StyleSheet.create({
  input: { ...mobileNativeChatInputBase.input, fontSize: COMPOSER_INPUT_FONT_SIZE }
})
