import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../../src/shared/clipboard/clipboard-image'

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
  // Raw base64 (no data: prefix).
  readonly base64: string
}

/** A picked file left in the shell's cache and read a chunk at a time, so no whole copy sits in page memory. */
export type StagedMobileFile = {
  readonly name: string
  readonly byteLength: number
  /** Raw base64 of up to `length` bytes from `offset`; `eof` once the file ends. */
  readonly read: (offset: number, length: number) => Promise<{ base64: string; eof: boolean }>
  /** Keeps the shell's copy while the file waits its turn: the shell drops one left idle for five minutes. */
  readonly keepAlive: () => Promise<void>
  /** Frees the shell's copy; a page holds only a few at once. */
  readonly release: () => Promise<void>
}

/** The shell no longer holds a picked file (it was idle too long, e.g. while the app was in the background). */
export class MobilePickedFileGoneError extends Error {
  constructor() {
    super('The phone no longer has that file; pick it again')
    this.name = 'MobilePickedFileGoneError'
  }
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

/** The shell already holds as many picked files as a page may; some must finish first. */
export class MobilePickedFilesBusyError extends Error {
  constructor() {
    super('Too many picked files are still waiting')
    this.name = 'MobilePickedFilesBusyError'
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
  /** Absent where the shell can't keep picked files for chunked reads (native screens, older shells). */
  pickStagedFiles?: () => Promise<readonly StagedMobileFile[]>
}
