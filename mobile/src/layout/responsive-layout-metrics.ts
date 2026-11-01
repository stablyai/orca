import { spacing } from '../theme/mobile-theme'

// Use actual window size so narrow iPad splits keep phone-like layouts.
const WIDE_LAYOUT_MIN_WIDTH = 700

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
