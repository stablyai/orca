import { useSyncExternalStore } from 'react'
import { OrcaReservedRegions, type ReservedRegions } from '../../modules/orca-reserved-regions/src'

const NO_REGIONS: ReservedRegions = { divisions: [], occlusions: [] }

let current = NO_REGIONS
const listeners = new Set<() => void>()
let observing = false

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Why: one app-lifetime native subscription; restarting it would report no regions until the
  // next layout pass.
  if (!observing && OrcaReservedRegions) {
    observing = true
    OrcaReservedRegions.addListener('onChange', (regions) => {
      current = regions
      for (const notify of listeners) {
        notify()
      }
    })
  }
  return () => {
    listeners.delete(listener)
  }
}

/** Active fold and camera regions in window points; none off iPhone Duo or before iOS 27.1. */
export function useReservedRegions(): ReservedRegions {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => NO_REGIONS
  )
}

/** Future native geometry only; cached frames must not overwrite a newer keyboard event. */
export function subscribeReservedRegionChanges(
  listener: (regions: ReservedRegions) => void
): () => void {
  return subscribe(() => listener(current))
}
