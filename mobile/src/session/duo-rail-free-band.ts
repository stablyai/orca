import { useSyncExternalStore } from 'react'
import type { BridgeSideStripFree } from '../mobile-web-shell/bridge/page-geometry/bridge-side-strip-cover'

// The session on screen publishes it; the page root reports it to the shell with the strip cover.
let band: BridgeSideStripFree | null = null
const listeners = new Set<() => void>()

function same(a: BridgeSideStripFree | null, b: BridgeSideStripFree | null): boolean {
  return a === b || (a !== null && b !== null && a.top === b.top && a.bottom === b.bottom)
}

export function publishDuoRailFreeBand(next: BridgeSideStripFree | null): void {
  if (same(band, next)) {
    return
  }
  band = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const read = (): BridgeSideStripFree | null => band

/** The part of the Duo's status column the session leaves empty; null while it uses all of it. */
export function useDuoRailFreeBand(): BridgeSideStripFree | null {
  return useSyncExternalStore(subscribe, read, read)
}
