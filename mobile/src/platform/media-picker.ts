import { pickMobileImage, pickMobileImages } from '../session/mobile-image-source-picker'
import { pickMobileFiles } from '../session/mobile-file-source-picker'
import type { MediaPicker } from './media-picker-contract'

// Keep Expo picker imports in the native sibling: their codegen lookup throws in browsers.
const devicePicker: MediaPicker = {
  pickImage: (source) => pickMobileImage(source),
  pickImages: (source) => pickMobileImages(source),
  pickFiles: () => pickMobileFiles()
}

export function useMediaPicker(): MediaPicker {
  // Reuse module functions so dependency lists do not restart effects each render.
  return devicePicker
}
