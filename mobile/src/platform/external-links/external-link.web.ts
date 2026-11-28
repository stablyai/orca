import {
  BRIDGE_LEGACY_EXTERNAL_LINK_CHARS,
  readBridgeExternalLinkUrl
} from '../../mobile-web-shell/bridge/protocol/bridge-caps'

// Use shell linking because RN Web window.open reports success even though both native WebViews refuse new windows.
// Publish outside React for plain-function callers; missing publication/invalid URLs log refusal without throwing from tap handlers.
// Resolves whether an app took the link where the shell can say so, else whether the shell took the URL.
type ExternalLinkOpener = (url: string) => boolean | Promise<boolean>

let post: ExternalLinkOpener = () => false
// The longest link the shell takes: older shells refuse one past the route href cap at the frame.
let maxChars = BRIDGE_LEGACY_EXTERNAL_LINK_CHARS

export function publishExternalLinkOpener(opener: ExternalLinkOpener, shellMaxChars: number): void {
  post = opener
  maxChars = shellMaxChars
}

/** False for a URL the shell would refuse, such as one past the length this shell takes. */
export function canOpenExternalLink(url: string): boolean {
  return readBridgeExternalLinkUrl(url, maxChars) !== null
}

/** False when the shell refused the URL or, on shells that report it, no app on the phone took it. */
export async function openExternalLink(url: string): Promise<boolean> {
  // Validate before posting: the shell drops refused frames without a reply, which would otherwise look like successful navigation.
  const target = readBridgeExternalLinkUrl(url, maxChars)
  if (target === null) {
    console.warn('[page] refused a URL outside the allowed schemes or this shell’s length', { url })
    return false
  }
  const opened = await Promise.resolve(post(target)).catch(() => false)
  if (!opened) {
    console.warn('[page] the shell did not open a URL', { url })
  }
  return opened
}
