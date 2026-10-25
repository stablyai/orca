import type { ReservedRegion } from 'react-native-reserved-regions'

export type ReservedRect = Readonly<{ x: number; y: number; width: number; height: number }>
export type ReservedRegions = {
  readonly divisions: readonly ReservedRect[]
  readonly occlusions: readonly ReservedRect[]
}

export function partitionReservedRegions(
  regions: readonly ReservedRegion[],
  origin: Readonly<{ x: number; y: number }> = { x: 0, y: 0 }
): ReservedRegions {
  const divisions: ReservedRect[] = []
  const occlusions: ReservedRect[] = []
  for (const region of regions) {
    const frame = { ...region.frame, x: region.frame.x + origin.x, y: region.frame.y + origin.y }
    if (region.kind === 'division') {
      divisions.push(frame)
    } else {
      occlusions.push(frame)
    }
  }
  return { divisions, occlusions }
}
