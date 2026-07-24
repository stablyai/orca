import { measureUtf8ByteLength } from '../shared/utf8-byte-limits'

export const REPO_LOCATION_CACHE_KEY_MAX_BYTES = 4 * 1024

export function getRepoLocationCacheKey(repo: {
  path: string
  connectionId?: string | null
}): string | null {
  const connectionId = repo.connectionId ?? 'local'
  const connectionBytes = measureUtf8ByteLength(connectionId, {
    stopAfterBytes: REPO_LOCATION_CACHE_KEY_MAX_BYTES - 1
  })
  if (connectionBytes.exceededLimit) {
    return null
  }
  const pathBytes = measureUtf8ByteLength(repo.path, {
    stopAfterBytes: REPO_LOCATION_CACHE_KEY_MAX_BYTES - connectionBytes.byteLength - 1
  })
  if (pathBytes.exceededLimit) {
    return null
  }
  return `${connectionId}\0${repo.path}`
}
