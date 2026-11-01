import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useWindowDimensions, type LayoutChangeEvent, type View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useSideRailStrip, useSideRailDirectionPadAvailable } from '../layout/side-rail'
import { pageOcclusions, type BridgePageGeometry } from './bridge/bridge-page-geometry'
import { getFoldSplit } from '../layout/fold-division'
import { useReservedRegions } from '../layout/reserved-regions'
import type { BridgeFoldDivision } from './bridge/bridge-fold-division'
import type { BridgeSafeAreaInsets } from './bridge/bridge-safe-area-insets'
import { measuredPageSafeAreaInsets } from './page-safe-area-insets'

type WindowFrame = { x: number; y: number; width: number; height: number }

/**
 * The fold splitting the page's WebView, in the page's px. The regions come in window points, so
 * the view is measured in the window: `rootRef` and `onRootLayout` go on its container,
 * and `onShellLayout` on the WebView itself.
 */
export function usePageFoldDivision(): {
  division: BridgeFoldDivision | null
  geometry: BridgePageGeometry
  safeAreaInsets: BridgeSafeAreaInsets
  rootRef: RefObject<View | null>
  onRootLayout: () => void
  onShellLayout: (event: LayoutChangeEvent) => void
} {
  const { divisions, occlusions, windowSafeArea } = useReservedRegions()
  const strip = useSideRailStrip()
  const sideRail = strip !== null
  const directionPadAvailable = useSideRailDirectionPadAvailable()
  const rootRef = useRef<View>(null)
  const layoutRef = useRef<WindowFrame | null>(null)
  const [frame, setFrame] = useState<WindowFrame | null>(null)
  const measure = useCallback(() => {
    const layout = layoutRef.current
    if (layout === null) {
      return
    }
    const { x, y, width, height } = layout
    rootRef.current?.measureInWindow((rootX, rootY) => {
      const next = { x: rootX + x, y: rootY + y, width, height }
      setFrame((held) =>
        held !== null &&
        held.x === next.x &&
        held.y === next.y &&
        held.width === next.width &&
        held.height === next.height
          ? held
          : next
      )
    })
  }, [])
  const onShellLayout = useCallback(
    (event: LayoutChangeEvent) => {
      layoutRef.current = event.nativeEvent.layout
      measure()
    },
    [measure]
  )
  // A 180° turn moves the status column across and the root with it, without a new local layout.
  const windowSize = useWindowDimensions()
  const insets = useSafeAreaInsets()
  useEffect(measure, [
    measure,
    windowSize.width,
    windowSize.height,
    insets.left,
    insets.right,
    insets.top,
    windowSafeArea
  ])
  const split = frame === null ? null : getFoldSplit(divisions, frame)
  const axis = split?.axis
  const start = split?.start
  const end = split?.end
  const division = useMemo(
    () =>
      axis === undefined || start === undefined || end === undefined ? null : { axis, start, end },
    [axis, start, end]
  )
  const geometry = useMemo(
    () => ({
      sideRail,
      directionPadAvailable,
      occlusions: pageOcclusions(occlusions, frame)
    }),
    [frame, occlusions, sideRail, directionPadAvailable]
  )
  const safeAreaInsets = useMemo(
    () => measuredPageSafeAreaInsets(windowSafeArea, frame, insets),
    [windowSafeArea, frame, insets]
  )
  return { division, geometry, safeAreaInsets, rootRef, onRootLayout: measure, onShellLayout }
}

/** Hands a moved fold to the page over the re-sent `init`, as the insets are. */
export function usePublishedFoldDivision(
  publish: (division: BridgeFoldDivision | null) => void,
  division: BridgeFoldDivision | null
): void {
  useEffect(() => {
    publish(division)
  }, [publish, division])
}
