// When each running child first saved its account's listing, so a later save never re-dates it.

const CHILD_LISTING_CLOCK_MAX = 256

/** When each running child first saved its listing, by the store's clock, for the latest children. */
export function childListingClock(now: () => number): (child: string) => number {
  const firstSaves = new Map<string, number>()
  return (child) => {
    const first = firstSaves.get(child)
    if (first !== undefined) {
      return first
    }
    const at = now()
    firstSaves.set(child, at)
    // Insertion order is age order: the oldest child's stamp goes first.
    for (const old of firstSaves.keys()) {
      if (firstSaves.size <= CHILD_LISTING_CLOCK_MAX) {
        break
      }
      firstSaves.delete(old)
    }
    return at
  }
}
