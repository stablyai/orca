import { readBridgeExternalLinkUrl } from '../mobile-web-shell/bridge/bridge-caps'

/**
 * Web sibling: the page has no way out of itself, so the shell is asked to open the URL.
 *
 * Not because `Linking` is missing here — react-native-web has one — but because its `openURL`
 * calls `window.open(url, '_blank', 'noopener')` and resolves whether or not anything opened, and
 * both shells refuse `window.open`: iOS returns nil from `createWebViewWith`, Android returns
 * false from `onCreateWindow`, and both set `javaScriptCanOpenWindowsAutomatically` false. Taking
 * that path would report success into a tap that did nothing.
 *
 * Published by the entry rather than read from context, because the callers are plain functions in
 * render trees the provider does not wrap — the same reason `publishPageStorage` exists. A document
 * that never published one refuses every URL, which is the right answer for a page with no shell.
 *
 * Refusals are named and logged and never thrown: a tap handler has no catch around it, and a URL
 * the shell would drop has to be visible as something other than silence.
 */
type ExternalLinkOpener = (url: string) => boolean

let post: ExternalLinkOpener = () => false

/** Called once by the entry, with the page client's own notify. */
export function publishExternalLinkOpener(opener: ExternalLinkOpener): void {
  post = opener
}

export function openExternalLink(url: string): void {
  // Checked before the post so the reason is this side's to name: the shell answers nothing, and a
  // refused frame would otherwise leave a tap looking exactly like one that opened a browser.
  if (readBridgeExternalLinkUrl(url) === null) {
    console.warn('[page] refused to open a URL outside the allowed schemes', { url })
    return
  }
  // The client normalizes again before it posts; this one only decides whether to ask at all.
  if (!post(url)) {
    console.warn('[page] the shell did not take a URL to open', { url })
  }
}
