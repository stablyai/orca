import { readBridgeExternalLinkUrl } from '../mobile-web-shell/bridge/bridge-caps'

// Use shell linking because RN Web window.open reports success even though both native WebViews refuse new windows.
// Publish outside React for plain-function callers; missing publication/invalid URLs log refusal without throwing from tap handlers.
type ExternalLinkOpener = (url: string) => boolean

let post: ExternalLinkOpener = () => false

export function publishExternalLinkOpener(opener: ExternalLinkOpener): void {
  post = opener
}

export function openExternalLink(url: string): void {
  // Validate before posting: the shell drops refused frames without a reply, which would otherwise look like successful navigation.
  if (readBridgeExternalLinkUrl(url) === null) {
    console.warn('[page] refused to open a URL outside the allowed schemes', { url })
    return
  }
  if (!post(url)) {
    console.warn('[page] the shell did not take a URL to open', { url })
  }
}
