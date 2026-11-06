import type { Image } from 'mdast'
import { htmlImages } from './mobile-markdown-preview-html'

/** Icons and badges this small stay out, as before: GitHub draws them inline beside their text. */
const MIN_DRAWN_IMAGE_WIDTH = 33

const ANCHOR_TAG = /<a\b|<\/a\s*>/gi

/** Whether `<a …>` tags before `at` are still open: a linked image (a badge) keeps its link. */
function insideLink(html: string, at: number): boolean {
  let open = 0
  for (const [tag] of html.slice(0, at).matchAll(ANCHOR_TAG)) {
    open = tag.startsWith('</') ? Math.max(0, open - 1) : open + 1
  }
  return open > 0
}

/** HTML cut around its https `<img>` tags: the HTML between them, and each image as a node that
 *  keeps its authored width. Icons and linked images (badges) stay in the HTML, as before. */
export function withImagesSplitOut(html: string): (string | Image)[] {
  const pieces: (string | Image)[] = []
  let from = 0
  for (const image of htmlImages(html)) {
    const icon = [image.width, image.height].some(
      (side) => side !== undefined && side < MIN_DRAWN_IMAGE_WIDTH
    )
    if (icon || insideLink(html, image.start)) {
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
