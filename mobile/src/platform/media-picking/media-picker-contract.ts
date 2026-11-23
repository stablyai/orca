import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../../src/shared/clipboard/clipboard-image'

// Keep contracts/errors free of Expo imports so a page-side instanceof cannot pull native picker code into the bundle.

export type MobileImageSource = 'camera' | 'library' | 'files'

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

export class CameraPermissionError extends Error {
  constructor() {
    super('Camera permission denied')
    this.name = 'CameraPermissionError'
  }
}

export class ImageLibraryPermissionError extends Error {
  constructor() {
    super('Photo library permission denied')
    this.name = 'ImageLibraryPermissionError'
  }
}

// Recent photos the Add context sheet chose, already resolved to images.
export type MobileRecentPhotoPick = {
  readonly recentPhotos: AsyncIterable<PickedMobileImage>
  // Frees whatever the reader never reached, including everything when the upload stops before reading.
  readonly release: () => void
}

// What the composer's Add context sheet asks to attach.
export type MobileComposerImagePick = 'library' | 'camera' | MobileRecentPhotoPick

export type RecentPhotoAccess = 'all' | 'limited' | 'denied'

export type RecentPhotos = { readonly access: RecentPhotoAccess; readonly ids: readonly string[] }

// In-process only: thumbnails are image URIs the app draws itself; pick yields JPEG copies, even for HEIC originals.
export type RecentPhotoLibrary = {
  list: (limit: number) => Promise<RecentPhotos>
  thumbnailUri: (id: string) => string
  manage: () => Promise<void>
  pick: (ids: readonly string[]) => AsyncIterable<PickedMobileImage>
}

export type AddContextOptions = {
  readonly images: boolean
  readonly files: boolean
  readonly structured: boolean
  readonly skillCount: number
}

export type AddContextChoice =
  | { readonly choice: Exclude<AddContextChoiceName, 'recent'> }
  | ({ readonly choice: 'recent' } & Omit<MobileRecentPhotoPick, 'recentPhotos'> & {
        readonly images: AsyncIterable<PickedMobileImage>
      })

export type AddContextChoiceName =
  | 'dismissed'
  | 'recent'
  | 'camera'
  | 'photos'
  | 'files'
  | 'workspaceFile'
  | 'skills'
  | 'commands'

// A hook supplies the page’s bridge context. Cancellation returns null/empty; refusal rejects so callers can show failure.
export type MediaPicker = {
  pickImage: (source: MobileImageSource) => Promise<PickedMobileImage | null>
  pickImages: (source: MobileImageSource) => AsyncIterable<PickedMobileImage>
  pickFiles: () => AsyncIterable<PickedMobileFile>
  // The app's own screens read recent photos in-process; null on the served page, which never sees the library.
  recentPhotos: RecentPhotoLibrary | null
  // The served page asks the shell to draw Add context, so only photos tapped there leave the shell; null elsewhere.
  openAddContext: ((options: AddContextOptions) => Promise<AddContextChoice>) | null
}
