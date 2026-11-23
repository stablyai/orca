import {
  pickMobileImage,
  pickMobileImages,
  pickRecentPhotos
} from '../../files/attachments/mobile-image-source-picker'
import { pickMobileFiles } from '../../files/attachments/mobile-file-source-picker'
import type { MediaPicker } from './media-picker-contract'
import { nativeRecentPhotoDevice } from './native-recent-photos-device'

// Keep Expo picker imports in the native sibling: their codegen lookup throws in browsers.
const devicePicker: MediaPicker = {
  pickImage: (source) => pickMobileImage(source),
  pickImages: (source) => pickMobileImages(source),
  pickFiles: () => pickMobileFiles(),
  recentPhotos: {
    list: (limit) => nativeRecentPhotoDevice.list(limit),
    // RN's Image draws ph:// ids itself, at the tile's size.
    thumbnailUri: (id) => id,
    manage: async () => {
      await nativeRecentPhotoDevice.manage()
    },
    pick: (ids) => pickRecentPhotos(ids, nativeRecentPhotoDevice)
  },
  openAddContext: null
}

export function useMediaPicker(): MediaPicker {
  // Reuse module functions so dependency lists do not restart effects each render.
  return devicePicker
}
