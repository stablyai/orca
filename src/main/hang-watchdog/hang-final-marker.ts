import {
  asHangObservations,
  emptyHangObservations,
  mergeHangObservations,
  type HangObservationCollection
} from './hang-observations'
import type { StoredHangMarker } from './hang-detection-marker'

/** The shutdown write's own file: async marker writes never touch it, so an in-flight rename cannot undo it. */
export function finalHangMarkerPath(markerPath: string): string {
  return `${markerPath}.final`
}

/** Next launch: the shutdown state (recovered stalls) wins over whatever an async write left behind. */
export function mergeFinalHangMarker(
  current: HangObservationCollection | null,
  final: StoredHangMarker | null | undefined
): HangObservationCollection | null {
  const closing = asHangObservations(final ?? null)
  if (!closing) {
    return current
  }
  return mergeHangObservations(current ?? emptyHangObservations(), closing)
}
