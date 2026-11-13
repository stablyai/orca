import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../src/shared/clipboard-image'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../../src/shared/agent-session/agent-session-attachments'

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
  // Base64 (no data: prefix) in order, each at most one upload chunk and padded only at the end, so a 200 MB file never sits in memory whole.
  // Call it at most once, and only while the file is the one the picker last yielded: iteration ending (or the picker advancing) releases the shell's handle.
  readonly chunks: () => AsyncIterable<string>
}

// Match the shell’s staging ceiling so native/page callers refuse the same file sizes.
export const MOBILE_PICKED_FILE_MAX_BYTES = CLIPBOARD_IMAGE_MAX_SOURCE_BYTES

const megabytes = (bytes: number): number => Math.floor(bytes / (1024 * 1024))

// 'update-app': an older shell staged the file only up to its own ceiling; 'limit': the current ceiling.
export class MobileFileTooLargeError extends Error {
  readonly reason: 'limit' | 'update-app'

  constructor(fileName: string | null, maxBytes: number, reason: 'limit' | 'update-app') {
    const base = `${fileName ?? 'That file'} is over ${megabytes(maxBytes)} MB`
    super(
      reason === 'update-app'
        ? `${base}. Update Orca on your phone to send files up to ${megabytes(AGENT_SESSION_ATTACHMENT_MAX_BYTES)} MB`
        : base
    )
    this.name = 'MobileFileTooLargeError'
    this.reason = reason
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
