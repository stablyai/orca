import { spacing } from '../theme/mobile-theme'

// Use actual window size so narrow iPad splits keep phone-like layouts.
const WIDE_LAYOUT_MIN_WIDTH = 700

// Why: width alone catches landscape phones; capped tablet layouts need room
// in both dimensions so phone rotation does not switch UI classes.
const TABLET_LAYOUT_MIN_SHORT_SIDE = 600

// Narrowest landscape phone; below it a top bar has no width left for the session tabs.
const LANDSCAPE_PHONE_MIN_WIDTH = 568

const CONTENT_MAX_WIDTH = 720
const MODAL_MAX_WIDTH = 480

export type ResponsiveLayoutMetrics = {
  width: number
  height: number
  isLandscape: boolean
  /** Window is wide enough to cap and center primary content. */
  isWideLayout: boolean
  /** Tablet-class canvas (both dimensions large); false in narrow splits. */
  isTabletLayout: boolean
  /** Phone turned sideways: too short to spend two rows on header chrome. */
  isLandscapePhone: boolean
  /** Max width for primary scrollable content on wide layouts. */
  contentMaxWidth: number
  /** Max width for centered sheets/dialogs on wide layouts. */
  modalMaxWidth: number
  /** Recommended horizontal gutter for the current width. */
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
    // Roomier gutters once content is capped so it isn't glued to the edges.
    horizontalPadding: isWideLayout ? spacing.xl : spacing.lg
  }
}
