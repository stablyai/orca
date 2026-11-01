// Decide whether a composer paste is an image. DOM details stay in the web listener.

export const MOBILE_COMPOSER_IMAGE_PASTE_EVENT = 'orca-composer-image-paste'

export type MobileComposerPastedImage = {
  readonly base64: string
  readonly uri?: string
}

export type MobileComposerImagePasteHandler = (
  images: readonly MobileComposerPastedImage[] | Promise<readonly MobileComposerPastedImage[]>
) => void | Promise<void>

export type MobileComposerImagePasteSnapshot = {
  readonly imageFileCount: number
  readonly otherFileCount: number
  readonly textPlain: string
  readonly textUriList: string
  readonly textHtml: string
}

export type MobileComposerImagePasteDecision = 'files' | 'native'

// Image bytes win. Real text, links, html, and non-image files stay with the field.
// An empty payload is the iOS case: the pasteboard holds an image the textarea cannot see.
export function mobileComposerImagePasteDecision(
  snapshot: MobileComposerImagePasteSnapshot
): MobileComposerImagePasteDecision | null {
  if (snapshot.imageFileCount > 0) {
    return 'files'
  }
  if (snapshot.textPlain.length > 0) {
    return null
  }
  if (snapshot.textUriList.trim().length > 0) {
    return null
  }
  if (snapshot.textHtml.trim().length > 0) {
    return null
  }
  if (snapshot.otherFileCount > 0) {
    return null
  }
  return 'native'
}

function lastPathSegment(path: string): string {
  const segment = path.split(/[\\/]/).pop()
  return segment && segment.length > 0 ? segment : path
}

function labelledFileName(line: string): string {
  if (line.startsWith('file://')) {
    try {
      return lastPathSegment(decodeURIComponent(line.replace(/^file:\/\/[^/]*/, '')))
    } catch {
      return line
    }
  }
  return /^(?:\/|[A-Za-z]:[\\/])/.test(line) ? lastPathSegment(line) : line
}

// Finder and file managers put one filename per copied file on the clipboard. That is not a caption.
export function mobileComposerImagePastePromptText(
  text: string,
  fileNames: readonly string[]
): string {
  if (text.length === 0 || fileNames.length === 0) {
    return text
  }
  const names = fileNames.map(lastPathSegment).sort()
  const labels = text
    .trim()
    .split(/\r\n|\r|\n/)
    .map((line) => labelledFileName(line.trim()))
    .sort()
  const onlyLabels =
    labels.length === names.length && labels.every((label, index) => label === names[index])
  return onlyLabels ? '' : text
}

/** A second path for the same paste can still be reading after the first one attaches. */
export const MOBILE_COMPOSER_PASTE_IMAGE_DEDUPE_MS = 2_000

export function selectMobileComposerPasteImages(
  images: readonly MobileComposerPastedImage[],
  seenAt: ReadonlyMap<string, number>,
  now: number
): { images: readonly MobileComposerPastedImage[]; seenAt: Map<string, number> } {
  const seen = new Map<string, number>()
  for (const [key, at] of seenAt) {
    if (now - at < MOBILE_COMPOSER_PASTE_IMAGE_DEDUPE_MS) {
      seen.set(key, at)
    }
  }
  const accepted: MobileComposerPastedImage[] = []
  for (const image of images) {
    const at = seen.get(image.base64)
    if (at !== undefined && now - at < MOBILE_COMPOSER_PASTE_IMAGE_DEDUPE_MS) {
      continue
    }
    seen.set(image.base64, now)
    accepted.push(image)
  }
  return { images: accepted, seenAt: seen }
}

/** File bytes and a clipboard read of the same paste can resolve in either order. */
export function createMobileComposerPasteImageDelivery(now: () => number = Date.now): {
  take(
    incoming: Promise<readonly MobileComposerPastedImage[]> | readonly MobileComposerPastedImage[]
  ): Promise<readonly MobileComposerPastedImage[]>
} {
  let seenAt = new Map<string, number>()
  let chain: Promise<void> = Promise.resolve()
  return {
    take(incoming) {
      const run = chain.then(async () => {
        const images = await incoming
        const selected = selectMobileComposerPasteImages(images, seenAt, now())
        seenAt = selected.seenAt
        return selected.images
      })
      chain = run.then(
        () => undefined,
        () => undefined
      )
      return run
    }
  }
}

export function spliceMobileComposerPasteText(
  value: string,
  insert: string,
  selection: { readonly start: number; readonly end: number }
): { text: string; caret: number } {
  if (insert.length === 0) {
    return { text: value, caret: selection.end }
  }
  const start = Math.min(Math.max(selection.start, 0), value.length)
  const end = Math.min(Math.max(selection.end, start), value.length)
  return { text: value.slice(0, start) + insert + value.slice(end), caret: start + insert.length }
}
