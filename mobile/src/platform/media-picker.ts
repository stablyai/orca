import { pickMobileImage, pickMobileImages } from '../session/mobile-image-source-picker'
import type { MediaPicker } from './media-picker-contract'

/**
 * Picking media on a phone: the OS pickers, exactly as the session screen has always reached
 * them.
 *
 * This file is the seam's native half and holds no logic of its own. The web sibling is where the
 * work is — a page served from a custom scheme has no photo library and no Files app — and the
 * reason the seam exists at all is that `expo-image-picker` and `expo-document-picker` are native
 * modules whose import runs a codegen lookup that throws in a browser.
 *
 * The pasteboard is the clipboard seam's on both platforms, not this one's.
 */
const devicePicker: MediaPicker = {
  pickImage: (source) => pickMobileImage(source),
  pickImages: (source) => pickMobileImages(source)
}

export function useMediaPicker(): MediaPicker {
  // No hook state: every member is a module function, so one frozen object serves every screen and
  // a caller may put it in a dependency list without re-running its effect on each render.
  return devicePicker
}
