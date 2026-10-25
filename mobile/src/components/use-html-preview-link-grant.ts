/**
 * Whether a tap on a link inside the HTML preview reaches anything.
 *
 * Native: this app is both halves of that path. The preview is its own WebView and
 * `onShouldStartLoadWithRequest` hands every request straight to `openExternalLink`, so there is
 * nothing to negotiate and nothing that can be missing. The `.web.ts` sibling is where the question
 * has an answer other than yes, because there the tap becomes a top-frame navigation that only the
 * shell around the page can cancel and open.
 */
export function useHtmlPreviewLinkGrant(): boolean {
  return true
}
