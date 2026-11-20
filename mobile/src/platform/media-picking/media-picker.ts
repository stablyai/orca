import {
  pickMobileImage,
  pickMobileImages
} from '../../files/attachments/mobile-image-source-picker'
import { pickMobileFiles } from '../../files/attachments/mobile-file-source-picker'
import { pickMobileGallery } from '../../files/attachments/mobile-gallery-source-picker'
import type { MediaPicker } from './media-picker-contract'

// Keep Expo picker imports in the native sibling: their codegen lookup throws in browsers.
const devicePicker: MediaPicker = {
  pickImage: (source) => pickMobileImage(source),
  pickImages: (source) => pickMobileImages(source),
  pickFiles: () => pickMobileFiles(),
  pickGallery: () => pickMobileGallery()
}

export function useMediaPicker(): MediaPicker {
  // Reuse module functions so dependency lists do not restart effects each render.
  return devicePicker
}
