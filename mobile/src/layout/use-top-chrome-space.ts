import { useCallback, useEffect, useRef, useState } from 'react'
import { useWindowDimensions, type View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ReservedRect } from '../../modules/orca-reserved-regions/src'
import { useReservedRegions } from './reserved-regions'
import { topChromeSpace } from './top-chrome-space'

export function useTopChromeSpace() {
  const ref = useRef<View>(null)
  const [frame, setFrame] = useState<ReservedRect | null>(null)
  const dimensions = useWindowDimensions()
  const { top } = useSafeAreaInsets()
  const { occlusions } = useReservedRegions()
  const onLayout = useCallback(
    () =>
      ref.current?.measureInWindow((x, y, width, height) => {
        setFrame((current) =>
          current?.x === x &&
          current.y === y &&
          current.width === width &&
          current.height === height
            ? current
            : { x, y, width, height }
        )
      }),
    []
  )
  useEffect(onLayout, [onLayout, top, occlusions, dimensions.width, dimensions.height])
  return { ref, onLayout, space: topChromeSpace(frame, top, occlusions) }
}
