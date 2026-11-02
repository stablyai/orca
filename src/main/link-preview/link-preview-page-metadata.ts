import {
  extractHtmlTitle,
  findIconHref,
  htmlTagAttributes,
  normalizeHtmlText
} from '../html-head-tags'

const MAX_TITLE_CHARS = 200
const MAX_DESCRIPTION_CHARS = 400

export type LinkPreviewPageMetadata = {
  title: string | null
  description: string | null
  siteName: string | null
  /** Absolute against the page that answered. */
  imageUrl: string | null
  /** As written in the page; may be relative or a data: URL. */
  iconHref: string
}

/** Decodes with the header charset, else `<meta charset>` or http-equiv, else UTF-8. */
export function decodeHtmlBody(body: Buffer, contentType: string): string {
  const label = charsetOf(contentType) ?? sniffMetaCharset(body)
  try {
    return new TextDecoder(label ?? 'utf-8').decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

function charsetOf(contentType: string): string | null {
  return /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1] ?? null
}

function sniffMetaCharset(body: Buffer): string | null {
  // Latin-1 keeps every byte, and tag syntax is ASCII in any charset a page can declare this way.
  for (const attributes of htmlTagAttributes(body.toString('latin1'), 'meta')) {
    const charset =
      attributes.get('charset') ??
      (attributes.get('http-equiv')?.toLowerCase() === 'content-type'
        ? charsetOf(attributes.get('content') ?? '')
        : null)
    if (charset) {
      return charset.trim()
    }
  }
  return null
}

export function readLinkPreviewMetadata(html: string, pageUrl: URL): LinkPreviewPageMetadata {
  const meta = new Map<string, string>()
  for (const attributes of htmlTagAttributes(html, 'meta')) {
    const content = attributes.get('content')
    if (content === undefined) {
      continue
    }
    for (const key of [attributes.get('property'), attributes.get('name')]) {
      const name = key?.toLowerCase()
      if (name && !meta.has(name)) {
        meta.set(name, content)
      }
    }
  }
  const pick = (...names: string[]): string | null => {
    for (const name of names) {
      const text = normalizeHtmlText(meta.get(name) ?? '')
      if (text) {
        return text
      }
    }
    return null
  }
  const title = pick('og:title', 'twitter:title') ?? extractHtmlTitle(html)
  const description = pick('og:description', 'twitter:description', 'description')
  const siteName = pick('og:site_name')
  const image = pick('og:image', 'og:image:secure_url', 'twitter:image')
  return {
    title: title && clamp(title, MAX_TITLE_CHARS),
    description: description && clamp(description, MAX_DESCRIPTION_CHARS),
    siteName: siteName && clamp(siteName, MAX_TITLE_CHARS),
    imageUrl: image && absoluteUrl(image, pageUrl),
    iconHref: findIconHref(html) ?? '/favicon.ico'
  }
}

function clamp(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) {
    return text
  }
  return `${chars
    .slice(0, maxChars - 1)
    .join('')
    .trimEnd()}…`
}

function absoluteUrl(href: string, base: URL): string | null {
  try {
    return new URL(href, base).href
  } catch {
    return null
  }
}
