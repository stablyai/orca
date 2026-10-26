import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../src/shared/clipboard-image'

// Keep contracts/errors free of Expo imports so a page-side instanceof cannot pull native picker code into the bundle.

export type MobileImageSource = 'library' | 'files'

export type PickedMobileImage = {
  // Raw base64 (no data: prefix); fed straight into the existing upload pipeline.
  readonly base64: string
  // Preview only; upload uses base64, and some sources cannot provide a local URI.
  readonly uri?: string
}

export type PickedMobileFile = {
  readonly name: string
  readonly mime: string
  readonly byteLength: number
  // Raw base64 (no data: prefix).
  readonly base64: string
}

// Match the shell’s staging ceiling so native/page callers refuse the same file sizes.
export const MOBILE_PICKED_FILE_MAX_BYTES = CLIPBOARD_IMAGE_MAX_SOURCE_BYTES

export class MobileFileTooLargeError extends Error {
  constructor(fileName: string | null) {
    super(
      `${fileName ?? 'That file'} is over ${Math.floor(MOBILE_PICKED_FILE_MAX_BYTES / (1024 * 1024))} MB`
    )
    this.name = 'MobileFileTooLargeError'
  }
}

export class ImageLibraryPermissionError extends Error {
  constructor() {
    super('Photo library permission denied')
    this.name = 'ImageLibraryPermissionError'
  }
}

// A hook supplies the page’s bridge context. Cancellation returns null/empty; refusal rejects so callers can show failure.
export type MediaPicker = {
  pickImage: (source: MobileImageSource) => Promise<PickedMobileImage | null>
  pickImages: (source: MobileImageSource) => AsyncIterable<PickedMobileImage>
  pickFiles: () => AsyncIterable<PickedMobileFile>
}
