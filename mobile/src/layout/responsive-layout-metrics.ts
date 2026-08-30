import { spacing } from '../theme/mobile-theme'

// Use actual window size so narrow iPad splits keep phone-like layouts.
const WIDE_LAYOUT_MIN_WIDTH = 700
const WIDE_LAYOUT_HYSTERESIS = 24

// Why: width alone catches landscape phones; capped tablet layouts need room
// in both dimensions so phone rotation does not switch UI classes.
const TABLET_LAYOUT_MIN_SHORT_SIDE = 600

// Material window-size classes; resizing a freeform window across a breakpoint
// must not toggle the sidebar on every pixel, so leaving a class costs the margin.
const WINDOW_CLASS_MEDIUM_MIN_WIDTH = 600
const WINDOW_CLASS_EXPANDED_MIN_WIDTH = 840
const WINDOW_CLASS_HYSTERESIS = 24

const CONTENT_MAX_WIDTH = 720
const MODAL_MAX_WIDTH = 480

export type WindowClass = 'compact' | 'medium' | 'expanded'

const WINDOW_CLASS_ORDER: WindowClass[] = ['compact', 'medium', 'expanded']

function resolveWindowClass(width: number, previous?: WindowClass): WindowClass {
  const previousIndex = previous ? WINDOW_CLASS_ORDER.indexOf(previous) : -1
  const threshold = (breakpoint: number, classIndex: number) =>
    previousIndex < 0
      ? breakpoint
      : previousIndex >= classIndex
        ? breakpoint - WINDOW_CLASS_HYSTERESIS
        : breakpoint + WINDOW_CLASS_HYSTERESIS
  if (width >= threshold(WINDOW_CLASS_EXPANDED_MIN_WIDTH, 2)) {
    return 'expanded'
  }
  return width >= threshold(WINDOW_CLASS_MEDIUM_MIN_WIDTH, 1) ? 'medium' : 'compact'
}

export type ResponsiveLayoutMetrics = {
  width: number
  height: number
  isLandscape: boolean
  /** Window is wide enough to cap and center primary content. */
  isWideLayout: boolean
  /** Tablet-class canvas (both dimensions large); false in narrow splits. */
  isTabletLayout: boolean
  windowClass: WindowClass
  /** Max width for primary scrollable content on wide layouts. */
  contentMaxWidth: number
  /** Max width for centered sheets/dialogs on wide layouts. */
  modalMaxWidth: number
  /** Recommended horizontal gutter for the current width. */
  horizontalPadding: number
}

export function getResponsiveLayoutMetrics(
  width: number,
  height: number,
  previous?: ResponsiveLayoutMetrics
): ResponsiveLayoutMetrics {
  const isTabletLayout = Math.min(width, height) >= TABLET_LAYOUT_MIN_SHORT_SIDE
  const wideThreshold = previous
    ? previous.isWideLayout
      ? WIDE_LAYOUT_MIN_WIDTH - WIDE_LAYOUT_HYSTERESIS
      : WIDE_LAYOUT_MIN_WIDTH + WIDE_LAYOUT_HYSTERESIS
    : WIDE_LAYOUT_MIN_WIDTH
  const isWideLayout = width >= wideThreshold && isTabletLayout
  const windowClass = resolveWindowClass(width, previous?.windowClass)

  return {
    width,
    height,
    isLandscape: width > height,
    isWideLayout,
    isTabletLayout,
    windowClass,
    contentMaxWidth: CONTENT_MAX_WIDTH,
    modalMaxWidth: MODAL_MAX_WIDTH,
    // Roomier gutters once content is capped so it isn't glued to the edges.
    horizontalPadding: isWideLayout ? spacing.xl : spacing.lg
  }
}
