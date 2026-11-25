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

/** The window's active reserved regions in window points; none before iOS 27.1. */
export function useReservedRegions(): ReservedRegions {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => NO_REGIONS
  )
}

/**
 * What a header may share the top strip beside: only a fold-division device's (iPhone Duo) camera.
 * Keeps out the status-bar-edge rect iPadOS 27.1 appears to report (inferred from a screenshot).
 */
export function useTopChromeOcclusions(): ReservedRegions['occlusions'] {
  const { hasFoldDivision, occlusions } = useReservedRegions()
  return hasFoldDivision ? occlusions : NO_REGIONS.occlusions
}

/** Future native geometry only; cached frames must not overwrite a newer keyboard event. */
export function subscribeReservedRegionChanges(
  listener: (regions: ReservedRegions) => void
): () => void {
  return subscribe(() => listener(current))
}
