import { StyleSheet } from 'react-native'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { customKeyInputBase } from './custom-key-input-base-styles'

/**
 * Web sibling: the capture field goes on the text-input seam.
 *
 * Every other input on this screen is raised by that move; this one is lowered, from 22 to the
 * seam's 16. Both sizes clear the floor below which iOS zooms the page on focus, so nothing about
 * the keyboard seam turns on which of them renders — what turns on it is that the census reads the
 * seam as a binding and not as a number, so there is no expression that keeps 22 here and still
 * says where the size came from. A 56px box holding one capitalised character carries 16 legibly,
 * and the alternative is a per-site exemption the next 14px input would inherit.
 */
export const customKeyInputStyles = StyleSheet.create({
  keyInput: { ...customKeyInputBase, fontSize: TEXT_INPUT_FONT_SIZE }
})
