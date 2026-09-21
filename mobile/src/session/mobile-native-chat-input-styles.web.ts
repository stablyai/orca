import { StyleSheet } from 'react-native'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { mobileNativeChatInputBase } from './mobile-native-chat-input-base-styles'

/**
 * Web sibling: both chat fields go on the text-input seam, one point up from the 15 they carry
 * natively and clear of the floor below which iOS zooms the page on focus.
 *
 * The zoom is not cosmetic on this screen. `keyboard-occlusion.web.ts` reads a visual viewport
 * scale other than 1 as "not a keyboard" and answers 0, so one focus of the composer would leave
 * the terminal's own keyboard lift at 0 for the rest of the session — and the terminal's input is
 * a hidden field whose only feedback that it is focused is the lift.
 */
export const mobileNativeChatInputStyles = StyleSheet.create({
  input: { ...mobileNativeChatInputBase.input, fontSize: TEXT_INPUT_FONT_SIZE },
  freeInput: { ...mobileNativeChatInputBase.freeInput, fontSize: TEXT_INPUT_FONT_SIZE }
})
