export const RUNTIME_TERMINAL_FILE_GRANT_MAX_ENTRIES = 1024

export function retainRuntimeTerminalFileGrant<T extends { id: string }>(
  grants: Map<string, T>,
  grant: T,
  release: (id: string, retained: T) => void,
  maxEntries = RUNTIME_TERMINAL_FILE_GRANT_MAX_ENTRIES
): void {
  while (grants.size >= Math.max(1, maxEntries)) {
    const oldestId = grants.keys().next().value as string | undefined
    if (oldestId === undefined) {
      break
    }
    const oldest = grants.get(oldestId)
    if (oldest) {
      release(oldestId, oldest)
    } else {
      grants.delete(oldestId)
    }
  }
  grants.set(grant.id, grant)
}
