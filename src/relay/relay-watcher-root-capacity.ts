export const MAX_RELAY_WATCH_ROOTS = 20
export const MAX_RELAY_WATCH_ROOT_KEY_BYTES = 64 * 1024
export const MAX_RELAY_WATCH_ROOT_KEYS_BYTES = 256 * 1024

export function assertRelayWatcherRootKeyCapacity(rootKey: string, rootPath = rootKey): void {
  if (
    Buffer.byteLength(rootKey, 'utf8') > MAX_RELAY_WATCH_ROOT_KEY_BYTES ||
    Buffer.byteLength(rootPath, 'utf8') > MAX_RELAY_WATCH_ROOT_KEY_BYTES
  ) {
    throw new Error('File watcher root path is too long')
  }
}

export function assertRelayWatcherRootCapacity(
  activeRoots: Iterable<string>,
  pendingRoots: Iterable<string>,
  teardownRoots: Iterable<string>,
  prospectiveRoot: string,
  prospectiveRootPath = prospectiveRoot
): void {
  assertRelayWatcherRootKeyCapacity(prospectiveRoot, prospectiveRootPath)
  const physicalRoots = new Set([...activeRoots, ...pendingRoots, ...teardownRoots])
  physicalRoots.add(prospectiveRoot)
  let retainedKeyBytes = 0
  for (const root of physicalRoots) {
    const keyBytes = Buffer.byteLength(root, 'utf8')
    if (keyBytes > MAX_RELAY_WATCH_ROOT_KEY_BYTES) {
      throw new Error('File watcher root path is too long')
    }
    retainedKeyBytes += keyBytes
    if (retainedKeyBytes > MAX_RELAY_WATCH_ROOT_KEYS_BYTES) {
      throw new Error('Maximum file watcher root path memory reached')
    }
  }
  if (physicalRoots.size > MAX_RELAY_WATCH_ROOTS) {
    throw new Error('Maximum number of file watchers reached')
  }
}
