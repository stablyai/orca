/**
 * Page routes an overlay opens over the screen beneath (Home's New Workspace): every layer above the
 * route's own drawer stays transparent, so that screen shows through dimmed by the drawer's scrim.
 */
export function isOverlayPageRoute(pathname: string): boolean {
  return /^\/h\/[^/]+\/new-workspace$/.test(pathname)
}
