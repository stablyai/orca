import { useMemo } from 'react'
import { Platform } from 'react-native'
import { useSafeAreaFrame } from 'react-native-safe-area-context'
import { getFoldSplit, type FoldSplit } from './fold-division'
import { useReservedRegions } from './reserved-regions'

function useMeasuredFoldSplit(): FoldSplit | null {
  const { divisions } = useReservedRegions()
  // Below `SideSafeArea` the frame is the padded area, in window points like the regions.
  const frame = useSafeAreaFrame()
  return useMemo(() => getFoldSplit(divisions, frame), [divisions, frame])
}

const noFoldSplit = (): FoldSplit | null => null

/**
 * The fold splitting the area `SideSafeArea` lays screens out in, in that area's coordinates.
 * Chosen once: Android keeps its existing layout without measuring iOS reserved regions.
 */
export const useFoldSplit = Platform.OS === 'ios' ? useMeasuredFoldSplit : noFoldSplit
