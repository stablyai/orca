import { useMemo } from 'react'
import { useSafeAreaFrame } from 'react-native-safe-area-context'
import { OrcaReservedRegions } from '../../modules/orca-reserved-regions/src'
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
 * Chosen once: a platform without the module never reports a fold, so it measures nothing.
 */
export const useFoldSplit = OrcaReservedRegions ? useMeasuredFoldSplit : noFoldSplit
