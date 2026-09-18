/** Stamps the order in which a recording wrote requests, payloads and effects. */
export type WriteOrdinal = () => number

/**
 * One counter per recording, shared by all three lists. Each list's own index already orders it
 * against itself; only a shared ordinal orders the three against each other — including in a family
 * that sends no requests, where the request count this replaced was `0` on every write.
 */
export function createWriteOrdinal(): WriteOrdinal {
  let written = 0
  return () => ++written
}
