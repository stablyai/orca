import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../../src/shared/clipboard/clipboard-image'
import { AGENT_SESSION_ATTACHMENT_UPLOAD_MAX_BYTES } from '../../../../src/shared/agent-session/agent-session-attachments'

// Keep contracts/errors free of Expo imports so a page-side instanceof cannot pull native picker code into the bundle.

export type MobileImageSource = 'library' | 'files'

export type PickedMobileImage = {
  // Raw base64 (no data: prefix); fed straight into the existing upload pipeline.
  readonly base64: string
  // Preview only; upload uses base64, and some sources cannot provide a local URI.
  readonly uri?: string
  // Non-image Files-app picks keep their name so the host saves the file under it.
  readonly fileName?: string
  // Decode hint for formats with no byte signature the phone recognizes (SVG, HEIC).
  readonly mime?: string
}

export type PickedMobileFile = {
  readonly name: string
  readonly mime: string
  readonly byteLength: number
  // Independent base64 slices in order (raw, no data: prefix), each a whole number of 3-byte groups except the last, so large files never sit in memory at once.
  readonly chunks: () => AsyncIterable<string>
  // Deletes the cache copy this pick made; safe to call more than once.
  readonly dispose?: () => void
  // The name was made up for a pick that has none, so a host that names files itself should not be sent it.
  readonly generatedName?: true
}

// The web shell stages files whole, so it keeps the shell’s staging ceiling.
export const MOBILE_PICKED_FILE_MAX_BYTES = CLIPBOARD_IMAGE_MAX_SOURCE_BYTES

// The native picker streams from disk, so only the host’s upload limit applies.
export const MOBILE_STREAMED_FILE_MAX_BYTES = AGENT_SESSION_ATTACHMENT_UPLOAD_MAX_BYTES

export class MobileFileTooLargeError extends Error {
  constructor(fileName: string | null, limitBytes: number = MOBILE_PICKED_FILE_MAX_BYTES) {
    super(`${fileName ?? 'That file'} is over ${Math.floor(limitBytes / (1024 * 1024))} MB`)
    this.name = 'MobileFileTooLargeError'
  }
}

/** The draft that asked for the upload was closed, or its chip removed, before the file finished. */
export class MobileUploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'MobileUploadCancelledError'
  }
}

export class ImageLibraryPermissionError extends Error {
  constructor() {
    super('Photo library permission denied')
    this.name = 'ImageLibraryPermissionError'
  }
}

/** One gallery selection: photos keep the image pipeline, videos stream as files because they can be far larger. */
export type MobileGalleryPick = {
  readonly images: readonly PickedMobileImage[]
  readonly videos: readonly PickedMobileFile[]
}

// A hook supplies the page’s bridge context. Cancellation returns null/empty; refusal rejects so callers can show failure.
export type MediaPicker = {
  pickImage: (source: MobileImageSource) => Promise<PickedMobileImage | null>
  pickImages: (source: MobileImageSource) => AsyncIterable<PickedMobileImage>
  pickFiles: () => AsyncIterable<PickedMobileFile>
  pickGallery: () => Promise<MobileGalleryPick>
}
