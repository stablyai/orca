import { useSyncExternalStore } from 'react'
import type { BridgeSideStripFree } from '../mobile-web-shell/bridge/page-geometry/bridge-side-strip-cover'

// Each mounted session keeps its own band; the page root reports the focused one's. The host stack
// keeps a chat mounted under a worker chat, so a single slot let the popped chat's late cleanup
// clear the band of the chat it returned to.
const bands = new Map<symbol, BridgeSideStripFree | null>()
let focused: symbol | null = null
let shown: BridgeSideStripFree | null = null
const listeners = new Set<() => void>()

function same(a: BridgeSideStripFree | null, b: BridgeSideStripFree | null): boolean {
  return a === b || (a !== null && b !== null && a.top === b.top && a.bottom === b.bottom)
}

function refresh(): void {
  const next = focused === null ? null : (bands.get(focused) ?? null)
  if (same(shown, next)) {
    return
  }
  shown = next
  for (const listener of listeners) {
    listener()
  }
}

export function publishDuoRailFreeBand(owner: symbol, next: BridgeSideStripFree | null): void {
  bands.set(owner, next)
  refresh()
}

/** The owner's route came into view; its band is the one reported from now on. */
export function focusDuoRailFreeBand(owner: symbol): void {
  focused = owner
  refresh()
}

/** The owner's route left view; a newer focus is left alone, whatever order the two arrive in. */
export function blurDuoRailFreeBand(owner: symbol): void {
  if (focused === owner) {
    focused = null
    refresh()
  }
}

export function releaseDuoRailFreeBand(owner: symbol): void {
  bands.delete(owner)
  blurDuoRailFreeBand(owner)
  refresh()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const readDuoRailFreeBand = (): BridgeSideStripFree | null => shown

/** The part of the Duo's status column the focused session leaves empty; null while it uses all of it. */
export function useDuoRailFreeBand(): BridgeSideStripFree | null {
  return useSyncExternalStore(subscribe, readDuoRailFreeBand, readDuoRailFreeBand)
}
