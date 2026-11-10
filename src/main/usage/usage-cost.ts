/** Sums optional costs; stays null only when neither side has a price. */
export function addUsageCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null
  }
  return (left ?? 0) + (right ?? 0)
}
