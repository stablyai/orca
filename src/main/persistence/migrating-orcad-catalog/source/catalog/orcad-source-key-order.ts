/** Code-unit key order, so every source export sorts identically on every host. */
export function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
