import { spacing } from '../theme/mobile-theme'

// Host split geometry; a detail pane narrower than the narrowest iPhone cramps chat and terminals.
export const HOST_SIDEBAR_MIN_WIDTH = 280
export const SPLIT_DETAIL_MIN_WIDTH = 375
const HOST_SIDEBAR_DEFAULT_MAX_WIDTH = 340

// 30% of the window until the user drags it: room for workspace names, the rest goes to the session.
export function defaultHostSidebarWidth(windowWidth: number): number {
  return Math.min(
    HOST_SIDEBAR_DEFAULT_MAX_WIDTH,
    Math.max(HOST_SIDEBAR_MIN_WIDTH, Math.round(windowWidth * 0.3))
  )
}

// Use actual window size so narrow iPad splits keep phone-like layouts; unfolded foldables split in both orientations.
const WIDE_LAYOUT_MIN_WIDTH = HOST_SIDEBAR_MIN_WIDTH + SPLIT_DETAIL_MIN_WIDTH

// Require room in both dimensions so rotating a landscape phone cannot switch it to tablet UI.
const TABLET_LAYOUT_MIN_SHORT_SIDE = 600

// Narrowest landscape phone; below it a top bar has no width left for the session tabs.
const LANDSCAPE_PHONE_MIN_WIDTH = 568

const CONTENT_MAX_WIDTH = 720
const MODAL_MAX_WIDTH = 480

export type ResponsiveLayoutMetrics = {
  width: number
  height: number
  isLandscape: boolean
  isWideLayout: boolean
  /** Tablet-class canvas (both dimensions large); false in narrow splits. */
  isTabletLayout: boolean
  /** Phone turned sideways: too short to spend two rows on header chrome. */
  isLandscapePhone: boolean
  contentMaxWidth: number
  modalMaxWidth: number
  horizontalPadding: number
}

export function getResponsiveLayoutMetrics(width: number, height: number): ResponsiveLayoutMetrics {
  const isTabletLayout = Math.min(width, height) >= TABLET_LAYOUT_MIN_SHORT_SIDE
  const isWideLayout = width >= WIDE_LAYOUT_MIN_WIDTH && isTabletLayout
  const isLandscape = width > height

  return {
    width,
    height,
    isLandscape,
    isWideLayout,
    isTabletLayout,
    isLandscapePhone: isLandscape && !isTabletLayout && width >= LANDSCAPE_PHONE_MIN_WIDTH,
    contentMaxWidth: CONTENT_MAX_WIDTH,
    modalMaxWidth: MODAL_MAX_WIDTH,
    horizontalPadding: isWideLayout ? spacing.xl : spacing.lg
  }
}
