import { useResponsiveLayout } from '../layout/responsive-layout'
import { usePageOwnsHostArea } from '../mobile-web-shell/routing/page-owns-host-area'

/**
 * Beside the page's own host sidebar the session is a pane whose header has Back, and the rail Back
 * would land outside it, so the rail neither draws nor reserves one there.
 */
export function useDuoRailBackShown(): boolean {
  const ownsHostArea = usePageOwnsHostArea()
  const { isWideLayout } = useResponsiveLayout()
  return !(ownsHostArea && isWideLayout)
}
