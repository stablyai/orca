// Native app owns preview WebView request→openExternalLink path and needs no negotiation; page’s web sibling must verify surrounding shell can open cancelled top navigation.
export function useHtmlPreviewLinkGrant(): boolean {
  return true
}
