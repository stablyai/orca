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
  // Read while uploading so a large file never sits in memory whole; valid until the picker iterates on.
  readonly readBytes: () => AsyncIterable<Uint8Array>
}

// Files stream to the host's chunked upload, so they share its ceiling rather than the in-memory image one.
export const MOBILE_PICKED_FILE_MAX_BYTES = AGENT_SESSION_ATTACHMENT_UPLOAD_MAX_BYTES

export class MobileFileTooLargeError extends Error {
  constructor(fileName: string | null, maxBytes: number = MOBILE_PICKED_FILE_MAX_BYTES) {
    super(`${fileName ?? 'That file'} is over ${Math.floor(maxBytes / (1024 * 1024))} MB`)
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
