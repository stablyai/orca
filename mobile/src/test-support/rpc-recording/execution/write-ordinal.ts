export type WriteOrdinal = () => number

// Share one counter across requests, payloads and effects so cross-list ordering stays visible even without requests.
export function createWriteOrdinal(): WriteOrdinal {
  let written = 0
  return () => ++written
}
