/** Published on the document root so every capped surface inherits one width. */
export function applySinglePaneCapVariables(root: HTMLElement, maxWidth: number | undefined): void {
  if (maxWidth === undefined) {
    // A stale inline value would keep overriding the stylesheet's own default.
    root.style.removeProperty('--pane-single-max-width')
    root.style.removeProperty('--pane-single-edge-width')
    return
  }
  const capped = maxWidth > 0
  // 0 means "no cap"; a 0px max-width would collapse the pane instead.
  root.style.setProperty('--pane-single-max-width', capped ? `${maxWidth}px` : 'none')
  // Uncapped fills the tab, so edge lines would just trace the window.
  root.style.setProperty('--pane-single-edge-width', capped ? '1px' : '0px')
}
