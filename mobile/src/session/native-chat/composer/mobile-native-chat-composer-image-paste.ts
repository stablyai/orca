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

const PASTED_IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,/i

// A clipboard read can already be a data URL. Preview must not prefix that URL again.
export function mobileComposerPastedImageFromClipboardData(
  data: string
): MobileComposerPastedImage {
  const base64 = data.replace(PASTED_IMAGE_DATA_URL_RE, '')
  return {
    base64,
    uri: PASTED_IMAGE_DATA_URL_RE.test(data) ? data : `data:image/png;base64,${base64}`
  }
}

/** An edit draft pastes only through its own handler. The route handler belongs to the live chat. */
export function mobileComposerImagePasteTarget(
  explicit: MobileComposerImagePasteHandler | undefined,
  route: MobileComposerImagePasteHandler | undefined,
  editing: boolean
): MobileComposerImagePasteHandler | undefined {
  return explicit ?? (editing ? undefined : route)
}

type SettledComposerPaste =
  | { ok: true; images: readonly MobileComposerPastedImage[] }
  | { ok: false; error: unknown }

/** Drop repeated bytes inside one paste, including a file read and a clipboard read still in flight. */
export function selectMobileComposerPasteImages(
  images: readonly MobileComposerPastedImage[],
  seen: ReadonlySet<string>
): { images: readonly MobileComposerPastedImage[]; seen: Set<string> } {
  const next = new Set(seen)
  const accepted: MobileComposerPastedImage[] = []
  for (const image of images) {
    if (next.has(image.base64)) {
      continue
    }
    next.add(image.base64)
    accepted.push(image)
  }
  return { images: accepted, seen: next }
}

/** Overlapping reads share one seen set. It clears once they settle, so the next paste is kept. */
export function createMobileComposerPasteImageDelivery(): {
  take(
    incoming: Promise<readonly MobileComposerPastedImage[]> | readonly MobileComposerPastedImage[]
  ): Promise<readonly MobileComposerPastedImage[]>
} {
  let seen = new Set<string>()
  let inflight = 0
  let chain: Promise<void> = Promise.resolve()
  return {
    take(incoming) {
      inflight += 1
      const settled = Promise.resolve(incoming).then(
        (images): SettledComposerPaste => ({ ok: true, images }),
        (error: unknown): SettledComposerPaste => ({ ok: false, error })
      )
      const run = chain.then(async () => {
        const result = await settled
        if (!result.ok) {
          throw result.error
        }
        const selected = selectMobileComposerPasteImages(result.images, seen)
        seen = selected.seen
        return selected.images
      })
      const finish = (): void => {
        inflight -= 1
        if (inflight === 0) {
          seen = new Set()
        }
      }
      chain = run.then(
        () => finish(),
        () => finish()
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
