import type { Image } from 'mdast'
import { htmlImages } from './mobile-markdown-preview-html'

/** Icons and badges this small stay out, as before: GitHub draws them inline beside their text. */
const MIN_DRAWN_IMAGE_WIDTH = 33

const TAG = /<(\/?)([a-z][a-z0-9-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi
const VOID_TAGS = new Set(['img', 'br', 'hr', 'source', 'input', 'meta', 'link', 'wbr'])
/** Elements that only place an image; one inside anything else (a link, a heading, bold) keeps it. */
const IMAGE_WRAPPERS = new Set(['p', 'div', 'picture', 'center'])

/** For each tag offset, whether every element open there only places images. One pass. */
function wrapperOnlyAt(html: string): Set<number> {
  const open: string[] = []
  const placeable = new Set<number>()
  for (const match of html.matchAll(TAG)) {
    const [, closing, name] = match
    const tag = name!.toLowerCase()
    if (tag === 'img') {
      if (open.every((element) => IMAGE_WRAPPERS.has(element))) {
        placeable.add(match.index)
      }
    } else if (closing) {
      const at = open.lastIndexOf(tag)
      if (at !== -1) {
        open.length = at
      }
    } else if (!VOID_TAGS.has(tag)) {
      open.push(tag)
    }
  }
  return placeable
}

/** HTML cut around its https `<img>` tags: the HTML between them, and each image as a node that
 *  keeps its authored width. Icons, and images inside links, headings or text styles, stay in the
 *  HTML as before, so their element keeps its meaning. */
export function withImagesSplitOut(html: string): (string | Image)[] {
  const pieces: (string | Image)[] = []
  const placeable = wrapperOnlyAt(html)
  let from = 0
  for (const image of htmlImages(html)) {
    const icon = [image.width, image.height].some(
      (side) => side !== undefined && side < MIN_DRAWN_IMAGE_WIDTH
    )
    if (icon || !placeable.has(image.start)) {
      continue
    }
    pieces.push(html.slice(from, image.start), {
      type: 'image',
      url: image.src,
      alt: image.alt || null,
      ...(image.width ? { data: { width: image.width } } : {})
    })
    from = image.end
  }
  pieces.push(html.slice(from))
  return pieces.filter((piece) => typeof piece !== 'string' || piece.trim())
}
