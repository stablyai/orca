import { Platform } from 'react-native'

/** Whether transcript text may carry `selectable` inline.
 *  Android's selectable TextView starts a word selection (with the magnifier) on a double tap or
 *  a long press, and a FlatList flicked twice in the same spot is a double tap — so scrolling the
 *  chat kept selecting words. There, selection moves behind a long-press sheet instead. iOS routes
 *  through UITextView, which arbitrates scroll against selection itself. */
export function inlineTextSelectionAllowed(os: string): boolean {
  return os !== 'android'
}

export const INLINE_TEXT_SELECTION = inlineTextSelectionAllowed(Platform.OS)
