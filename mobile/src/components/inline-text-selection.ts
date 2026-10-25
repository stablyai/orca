import { Platform } from 'react-native'

// Android double-tap selection can mistake successive scroll flicks for word selection.
export function inlineTextSelectionAllowed(os: string): boolean {
  return os !== 'android'
}

export const INLINE_TEXT_SELECTION = inlineTextSelectionAllowed(Platform.OS)
