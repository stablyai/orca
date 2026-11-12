export const MOBILE_CLIPBOARD_IMAGE_PROVENANCE_TTL_MS = 60 * 60 * 1000
export const MOBILE_CLIPBOARD_IMAGE_PROVENANCE_MAX_ENTRIES = 256
const MOBILE_CLIPBOARD_IMAGE_PROVENANCE_MAX_PER_CLIENT = 64

const pathsByClient = new Map<string, Map<string, number>>()
let entryCount = 0

function deletePath(clientId: string, path: string): void {
  const paths = pathsByClient.get(clientId)
  if (!paths?.delete(path)) {
    return
  }
  entryCount--
  if (paths.size === 0) {
    pathsByClient.delete(clientId)
  }
}

function pruneExpired(now: number): void {
  for (const [clientId, paths] of pathsByClient) {
    for (const [path, expiresAt] of paths) {
      if (expiresAt <= now) {
        deletePath(clientId, path)
      }
    }
  }
}

function deleteOldestEntry(): void {
  let oldest: { clientId: string; path: string; expiresAt: number } | null = null
  for (const [clientId, paths] of pathsByClient) {
    for (const [path, expiresAt] of paths) {
      if (!oldest || expiresAt < oldest.expiresAt) {
        oldest = { clientId, path, expiresAt }
      }
    }
  }
  if (oldest) {
    deletePath(oldest.clientId, oldest.path)
  }
}

export function recordMobileClipboardImagePath(clientId: string | undefined, path: string): void {
  const owner = clientId?.trim()
  if (!owner) {
    return
  }
  const now = Date.now()
  pruneExpired(now)
  let paths = pathsByClient.get(owner)
  if (!paths) {
    paths = new Map()
    pathsByClient.set(owner, paths)
  }
  if (paths.delete(path)) {
    entryCount--
  }
  while (paths.size >= MOBILE_CLIPBOARD_IMAGE_PROVENANCE_MAX_PER_CLIENT) {
    const oldestPath = paths.keys().next().value
    if (typeof oldestPath !== 'string') {
      break
    }
    deletePath(owner, oldestPath)
  }
  while (entryCount >= MOBILE_CLIPBOARD_IMAGE_PROVENANCE_MAX_ENTRIES) {
    deleteOldestEntry()
  }
  paths = pathsByClient.get(owner) ?? new Map<string, number>()
  pathsByClient.set(owner, paths)
  paths.set(path, now + MOBILE_CLIPBOARD_IMAGE_PROVENANCE_TTL_MS)
  entryCount++
}

export function hasMobileClipboardImagePath(clientId: string | undefined, path: string): boolean {
  const owner = clientId?.trim()
  if (!owner) {
    return false
  }
  pruneExpired(Date.now())
  return pathsByClient.get(owner)?.has(path) ?? false
}

export function resetMobileClipboardImageProvenanceForTest(): void {
  pathsByClient.clear()
  entryCount = 0
}

export function mobileClipboardImageProvenanceSizeForTest(): number {
  return entryCount
}
