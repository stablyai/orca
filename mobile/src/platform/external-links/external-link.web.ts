import { readBridgeExternalLinkUrl } from '../../mobile-web-shell/bridge/protocol/bridge-caps'

// Use shell linking because RN Web window.open reports success even though both native WebViews refuse new windows.
// Publish outside React for plain-function callers; missing publication/invalid URLs log refusal without throwing from tap handlers.
// Resolves whether an app took the link where the shell can say so, else whether the shell took the URL.
type ExternalLinkOpener = (url: string) => boolean | Promise<boolean>

let post: ExternalLinkOpener = () => false

export function publishExternalLinkOpener(opener: ExternalLinkOpener): void {
  post = opener
}

/** False for a URL the shell would refuse, such as one past the bridge's length limit. */
export function canOpenExternalLink(url: string): boolean {
  return readBridgeExternalLinkUrl(url) !== null
}

/** False when the shell refused the URL or, on shells that report it, no app on the phone took it. */
export async function openExternalLink(url: string): Promise<boolean> {
  // Validate before posting: the shell drops refused frames without a reply, which would otherwise look like successful navigation.
  if (readBridgeExternalLinkUrl(url) === null) {
    console.warn('[page] refused to open a URL outside the allowed schemes', { url })
    return false
  }
  const opened = await Promise.resolve(post(url)).catch(() => false)
  if (!opened) {
    console.warn('[page] the shell did not open a URL', { url })
  }
  return opened
}
