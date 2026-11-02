import { hostOs } from '../platform/host-os'

// Android double-tap selection can mistake successive scroll flicks for word selection.
export function inlineTextSelectionAllowed(os: string): boolean {
  return os !== 'android'
}

// The hosted transcript runs as web; its phone OS still owns the selection gesture.
export const INLINE_TEXT_SELECTION = inlineTextSelectionAllowed(hostOs())
