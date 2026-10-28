export function pruneOldestMapEntry<K, V>(map: Map<K, V>, maxEntries: number): void {
  if (map.size <= maxEntries) {
    return
  }
  const oldest = map.keys().next()
  if (!oldest.done) {
    map.delete(oldest.value)
  }
}
