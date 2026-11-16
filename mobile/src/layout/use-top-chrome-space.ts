import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, useWindowDimensions, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ReservedRect } from '../../modules/orca-reserved-regions/src'
import { useReservedRegions } from './reserved-regions'
import { topChromeSpace } from './top-chrome-space'

export function useTopChromeSpace() {
  const ref = useRef<HostInstance>(null)
  const [frame, setFrame] = useState<ReservedRect | null>(null)
  const dimensions = useWindowDimensions()
  const { top } = useSafeAreaInsets()
  const { occlusions } = useReservedRegions()
  const onLayout = useCallback(() => {
    const updateFrame = (x: number, y: number, width: number, height: number) => {
      setFrame((current) =>
        current?.x === x && current.y === y && current.width === width && current.height === height
          ? current
          : { x, y, width, height }
      )
    }
    // RN Web's measure excludes screen transitions; native regions use window coordinates.
    if (Platform.OS === 'web') {
      ref.current?.measure((_x, _y, width, height, pageX, pageY) => {
        updateFrame(pageX, pageY, width, height)
      })
    } else {
      ref.current?.measureInWindow(updateFrame)
    }
  }, [])
  useEffect(onLayout, [onLayout, top, occlusions, dimensions.width, dimensions.height])
  return { ref, onLayout, space: topChromeSpace(frame, top, occlusions) }
}
