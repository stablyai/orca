import { routeNativeChatHref } from '../../../src/shared/native-chat-href-routing'
import { openExternalLink } from '../platform/external-link'

export type MarkdownHrefRoute =
  | { kind: 'web'; url: string }
  | { kind: 'file'; pathText: string }
  | { kind: 'none' }

function withLineSuffix(pathText: string, line: number | null): string {
  return line === null ? pathText : `${pathText}:${line}`
}

// Mirrors isExternalMarkdownImageSrc in session/markdown-relative-image-srcs.ts, kept local so
// this light module does not pull the image-read RPC graph into every route that renders prose.
const EXTERNAL_IMAGE_SRC = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

export function routeMarkdownHref(href: string): MarkdownHrefRoute {
  const route = routeNativeChatHref(href)
  if (route.kind !== 'file') {
    return route
  }
  return { kind: 'file', pathText: withLineSuffix(route.pathText, route.line) }
}

// Web/mail hrefs open the system handler; file-target hrefs (file: URIs and
// scheme-less paths — the entire desktop file-link contract) go to onOpenFile.
export function openMarkdownHref(href: string, onOpenFile?: (pathText: string) => void): void {
  const route = routeMarkdownHref(href)
  if (route.kind === 'web') {
    // The seam, not react-native's `Linking`: inside the shell's WebView `openURL`
    // resolves without opening anything.
    openExternalLink(route.url)
    return
  }
  if (route.kind === 'file' && onOpenFile) {
    onOpenFile(route.pathText)
  }
}

// The dedicated src-keyed handler owns image taps; external srcs route as web hrefs.
export function openMarkdownImage(
  rawSrc: string,
  onOpenFile?: (pathText: string) => void,
  onOpenImage?: (rawSrc: string) => void
): void {
  if (onOpenImage && !EXTERNAL_IMAGE_SRC.test(rawSrc)) {
    onOpenImage(rawSrc)
    return
  }
  openMarkdownHref(rawSrc, onOpenFile)
}
