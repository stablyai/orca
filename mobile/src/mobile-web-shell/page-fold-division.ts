import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useWindowDimensions, type LayoutChangeEvent, type ViewInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { getFoldSplit } from '../layout/fold-division'
import { useReservedRegions } from '../layout/reserved-regions'
import type { BridgeFoldDivision } from './bridge/bridge-fold-division'

type WindowFrame = { x: number; y: number; width: number; height: number }

/**
 * The fold splitting the page's WebView, in the page's px. The regions come in window points, so
 * the view is measured in the window: `rootRef` goes on the view the WebView is laid out in and
 * `onShellLayout` on the WebView itself.
 */
export function usePageFoldDivision(): {
  division: BridgeFoldDivision | null
  rootRef: RefObject<ViewInstance | null>
  onShellLayout: (event: LayoutChangeEvent) => void
} {
  const { divisions } = useReservedRegions()
  const rootRef = useRef<ViewInstance>(null)
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
    insets.top
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
  return { division, rootRef, onShellLayout }
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
