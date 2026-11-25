import { BRIDGE_BACK_EDGE_GUARD_LIMIT, type BridgeBackEdgeGuard } from './bridge-page-back'

/** One piece of the page that keeps edge swipes: place it as it moves, release it when it goes. */
export type PageBackEdgeGuard = {
  readonly place: (band: BridgeBackEdgeGuard | null) => void
  readonly release: () => void
}

export type PageBackClaimState = {
  /** The Back claim's empty/non-empty edge, from the page's Back consumers. */
  readonly publishClaim: (claimed: boolean) => void
  /**
   * After `init`: ready clears the shell's bands, and an init can move the page (new safe-area
   * insets) without resizing anything, so every owner measures again.
   */
  readonly reassertGuards: () => void
  /** `measure` places the guard again; it runs on every `init`. */
  readonly guard: (measure: () => void) => PageBackEdgeGuard
}

// The Back claim carries whole state (see bridge-notify-envelope), so the claim and every band publish as one.
// Bands are left out until one has ever been placed, so other pages' frames stay as they were.
export function createPageBackClaimState(
  notify: (claimed: boolean, edgeGuards: readonly BridgeBackEdgeGuard[] | undefined) => void
): PageBackClaimState {
  const bands = new Map<symbol, BridgeBackEdgeGuard>()
  const measures = new Set<() => void>()
  let everPlaced = false
  let claimed = false
  // Sent whether or not Back is claimed: the session page holds a claim the whole time it shows.
  const publish = () =>
    notify(
      claimed,
      everPlaced ? [...bands.values()].slice(0, BRIDGE_BACK_EDGE_GUARD_LIMIT) : undefined
    )

  const set = (owner: symbol, band: BridgeBackEdgeGuard | null) => {
    const before = bands.get(owner)
    if (band === null) {
      if (!bands.delete(owner)) {
        return
      }
    } else {
      if (before && before.top === band.top && before.bottom === band.bottom) {
        return
      }
      bands.set(owner, band)
      everPlaced = true
    }
    publish()
  }

  return {
    publishClaim: (next) => {
      claimed = next
      publish()
    },
    reassertGuards: () => {
      // A held claim is reasserted with its bands already; an unclaimed page sends them here.
      if (!claimed && bands.size > 0) {
        publish()
      }
      for (const measure of measures) {
        measure()
      }
    },
    guard: (measure) => {
      const owner = Symbol('back edge guard')
      measures.add(measure)
      return {
        place: (band) => set(owner, band),
        release: () => {
          measures.delete(measure)
          set(owner, null)
        }
      }
    }
  }
}
