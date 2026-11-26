import type { Image } from 'mdast'
import { routeMarkdownHref } from '../links/markdown-href-routing'
import { attrValue, htmlImages } from './mobile-markdown-preview-html'

/** Icons and badges this small stay out, as before: GitHub draws them inline beside their text. */
const MIN_DRAWN_IMAGE_WIDTH = 33

const TAG = /<(\/?)([a-z][a-z0-9-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi
const VOID_TAGS = new Set(['img', 'br', 'hr', 'source', 'input', 'meta', 'link', 'wbr'])
const IMAGE_WRAPPERS = new Set(['p', 'div', 'picture', 'center'])

const HEADING_TAG = /^h[1-6]$/
const ANCHOR_CLOSE = /\s*<\/a\s*>/iy

type Placement = {
  start: number
  end: number
  linkHref?: string
  heading?: string
}

function imagePlacements(html: string, documentImages: boolean): Map<number, Placement> {
  const open: { tag: string; start: number; end: number }[] = []
  const placements = new Map<number, Placement>()
  for (const match of html.matchAll(TAG)) {
    const [, closing, name] = match
    const tag = name!.toLowerCase()
    const start = match.index
    const end = start + match[0].length
    if (tag === 'img') {
      const anchor = documentImages && open.at(-1)?.tag === 'a' ? open.at(-1) : undefined
      const wrappers = anchor ? open.slice(0, -1) : open
      if (
        !wrappers.every(
          ({ tag }) => IMAGE_WRAPPERS.has(tag) || (documentImages && HEADING_TAG.test(tag))
        )
      ) {
        continue
      }
      const heading = wrappers.findLast(({ tag }) => HEADING_TAG.test(tag))?.tag
      if (anchor) {
        ANCHOR_CLOSE.lastIndex = end
        if (!html.slice(anchor.end, start).trim() && ANCHOR_CLOSE.test(html)) {
          const linkHref = attrValue(html.slice(anchor.start, anchor.end), 'href')
          placements.set(start, {
            start: anchor.start,
            end: ANCHOR_CLOSE.lastIndex,
            linkHref,
            heading
          })
        }
      } else {
        placements.set(start, { start, end, heading })
      }
    } else if (closing) {
      const at = open.findLastIndex((entry) => entry.tag === tag)
      if (at !== -1) {
        open.length = at
      }
    } else if (!VOID_TAGS.has(tag)) {
      open.push({ tag, start, end })
    }
  }
  return placements
}

function isImageSource(src: string, documentImages: boolean): boolean {
  if (/^https:\/\//i.test(src)) {
    return true
  }
  return documentImages && (/^http:\/\//i.test(src) || routeMarkdownHref(src).kind === 'file')
}

export function withImagesSplitOut(html: string, documentImages: boolean): (string | Image)[] {
  const pieces: (string | Image)[] = []
  const placements = imagePlacements(html, documentImages)
  let from = 0
  let reopen = ''
  for (const image of htmlImages(html, (src) => isImageSource(src, documentImages))) {
    const icon =
      !documentImages &&
      [image.width, image.height].some((side) => side !== undefined && side < MIN_DRAWN_IMAGE_WIDTH)
    const placement = placements.get(image.start)
    if (icon || !placement) {
      continue
    }
    const { start, end, linkHref, heading } = placement
    // Split a heading around the image without demoting the text on either side.
    pieces.push(reopen + html.slice(from, start) + (heading ? `</${heading}>` : ''), {
      type: 'image',
      url: image.src,
      alt: image.alt || null,
      data: { width: image.width, linkHref }
    })
    reopen = heading ? `<${heading}>` : ''
    from = end
  }
  pieces.push(reopen + html.slice(from))
  return pieces.filter((piece) => typeof piece !== 'string' || piece.trim())
}
