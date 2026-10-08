import { StyleSheet } from 'react-native'
import { typography } from '../theme/mobile-theme'
import { mobileNativeChatInputBase } from './mobile-native-chat-input-base-styles'

/**
 * Native: both chat fields sit one point above the body size, which is what they have rendered at.
 *
 * The `.web.ts` sibling raises them to the text-input seam, because 15 is under the size below
 * which iOS zooms the page on focus — and this screen is the one that cannot afford that zoom, the
 * terminal's keyboard lift being pure geometry on a document it assumes is at scale 1.
 */
const CHAT_INPUT_FONT_SIZE = typography.bodySize + 1

export const mobileNativeChatInputStyles = StyleSheet.create({
  input: { ...mobileNativeChatInputBase.input, fontSize: CHAT_INPUT_FONT_SIZE },
  freeInput: { ...mobileNativeChatInputBase.freeInput, fontSize: CHAT_INPUT_FONT_SIZE }
})
