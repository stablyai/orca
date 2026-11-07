import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import type { Root, RootContent } from 'hast'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const githubBodyAssetPath = new RegExp(`/assets/(?:\\d+/)?(${UUID})$`, 'i')

export function githubBodyImageCandidates(body: string): Map<string, URL> {
  const originals = new Map<string, URL>()
  for (const match of body.matchAll(/https:\/\/[^\s<>"'`()[\]]+/g)) {
    if (!match[0].includes('/assets/')) {
      continue
    }
    try {
      const url = new URL(match[0])
      if (githubBodyAssetPath.test(url.pathname)) {
        originals.set(match[0], url)
      }
    } catch {
      // An invalid Markdown URL cannot identify an attachment.
    }
  }
  return originals
}

const imageId = new RegExp(UUID, 'i')
export const GITHUB_BODY_MEDIA_TYPE = 'Accept: application/vnd.github.full+json'

export function githubBodyMediaHeaders(body: string): string[] {
  return githubBodyImageCandidates(body).size ? ['-H', GITHUB_BODY_MEDIA_TYPE] : []
}

/** Keep short-lived display URLs separate from editable Markdown and persisted item metadata. */
export function githubBodyImageUrls(
  body: unknown,
  html: unknown
): Record<string, string> | undefined {
  if (typeof body !== 'string' || typeof html !== 'string' || !html) {
    return undefined
  }
  try {
    const originals = githubBodyImageCandidates(body)
    if (!originals.size) {
      return undefined
    }

    const signed = new Map<string, URL>()
    const pending: (Root | RootContent)[] = [fromHtmlIsomorphic(html, { fragment: true })]
    while (pending.length) {
      const node = pending.pop()!
      if ('children' in node) {
        pending.push(...node.children)
      }
      if (node.type !== 'element' || node.tagName !== 'img') {
        continue
      }
      const src = node.properties.src
      if (typeof src !== 'string') {
        continue
      }
      try {
        const url = new URL(src)
        const id = url.pathname.match(imageId)?.[0].toLowerCase()
        if (id && url.protocol === 'https:') {
          signed.set(id, url)
        }
      } catch {
        // Relative or malformed HTML sources do not supply a signed attachment URL.
      }
    }

    const result: Record<string, string> = {}
    for (const [original, url] of originals) {
      const id = url.pathname.match(githubBodyAssetPath)![1].toLowerCase()
      const display = signed.get(id)
      if (
        display &&
        display.href !== original &&
        (display.hostname.endsWith('.githubusercontent.com') || display.host === url.host)
      ) {
        result[original] = display.href
      }
    }
    return Object.keys(result).length ? result : undefined
  } catch {
    return undefined
  }
}
