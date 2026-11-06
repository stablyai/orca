import type { Image } from 'mdast'
import { htmlImages } from './mobile-markdown-preview-html'

/** Icons and badges this small stay out, as before: GitHub draws them inline beside their text. */
const MIN_DRAWN_IMAGE_WIDTH = 33

/** HTML cut around its https `<img>` tags: the HTML between them, and each image as a node that
 *  keeps its authored width. */
export function withImagesSplitOut(html: string): (string | Image)[] {
  const pieces: (string | Image)[] = []
  let from = 0
  for (const image of htmlImages(html)) {
    if (image.width !== undefined && image.width < MIN_DRAWN_IMAGE_WIDTH) {
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
