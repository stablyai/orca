import { StyleSheet } from 'react-native'
import { customKeyInputBase } from './custom-key-input-base-styles'

/**
 * Native: the single character this field captures is shown large, which is what it has rendered
 * at since the modal existed.
 *
 * The `.web.ts` sibling puts it on the text-input seam instead. That is a reduction rather than
 * the raise every other input in this closure gets — 22 is already clear of the focus-zoom floor —
 * and it is the price of the seam being a binding rule rather than a number: a size the census
 * cannot follow to the seam module is one nobody can tell from a 14 that was left behind.
 */
export const customKeyInputStyles = StyleSheet.create({
  keyInput: { ...customKeyInputBase, fontSize: 22 }
})
