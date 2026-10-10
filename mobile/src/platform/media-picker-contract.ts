/**
 * What picking media means to the screens, free of any device API.
 *
 * The two siblings of `media-picker.ts` agree on this and nothing else: one opens the OS pickers
 * over `expo-image-picker` and `expo-document-picker`, the other asks the shell for them over
 * `native.media.pick` / `read` / `release`. Neither type nor error may live beside an Expo import,
 * because a screen that catches `ImageLibraryPermissionError` would otherwise drag the native
 * picker chain into the page bundle for the sake of one `instanceof`.
 *
 * The pasteboard is not here: `platform/clipboard.ts` owns it on both platforms, and on the web
 * its `readImage` reaches the same `native.media.pick` with `source: 'clipboard'`.
 */

/** Where a picked image comes from. The pasteboard is the clipboard seam's, not a source here. */
export type MobileImageSource = 'library' | 'files'

export type PickedMobileImage = {
  // Raw base64 (no data: prefix); fed straight into the existing upload pipeline.
  readonly base64: string
  // Local file URI of the picked asset — used only to render a composer preview
  // thumbnail (the host upload uses `base64`); absent when the source can't supply one.
  readonly uri?: string
}

export class ImageLibraryPermissionError extends Error {
  constructor() {
    super('Photo library permission denied')
    this.name = 'ImageLibraryPermissionError'
  }
}

/**
 * Picking on whichever half of the app is running.
 *
 * A hook rather than three functions because the web sibling needs the page's bridge client, which
 * is React context — the shape the clipboard seam already has.
 *
 * Rejecting is how every one of these reports failure, and a cancelled picker is not a failure: it
 * answers `null` or an empty sequence. The web sibling never turns a refusal into one of those,
 * because "the shell refused the pick" and "the user changed their mind" lead a caller to opposite
 * screens.
 */
export type MediaPicker = {
  pickImage: (source: MobileImageSource) => Promise<PickedMobileImage | null>
  pickImages: (source: MobileImageSource) => AsyncIterable<PickedMobileImage>
}
