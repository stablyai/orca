import {
  readProtectedUsageCacheJson,
  protectedUsageCacheJson
} from '../usage/cache/usage-cache-protected-json'
import {
  decodedUsageCacheText,
  MIN_GZIP_PLAIN_BYTES,
  publishGzipUsageCache
} from '../usage/cache/usage-cache-gzip'
import {
  writeUsageSourceCacheData,
  type UsageSourceCacheRef
} from '../usage/cache/usage-source-cache-file'

// Builds before the shared gzip reader reject larger expansions, so keep their limit for downgrades.
const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024

export async function readClaudeUsageJson<T extends { usageIntegrity?: unknown }>(
  path: string,
  domain: string,
  strict = true
): Promise<{ parsed: T; verified: boolean }> {
  return readProtectedUsageCacheJson<T>(decodedUsageCacheText(path), domain, strict)
}

export async function writeClaudeUsageJson(
  ref: UsageSourceCacheRef,
  value: unknown,
  domain: string,
  sealed: boolean
): Promise<void> {
  const material = protectedUsageCacheJson(value, domain, sealed)
  const compressible =
    material.bytes >= MIN_GZIP_PLAIN_BYTES && material.bytes <= MAX_COMPRESSED_BYTES
  if (
    !compressible ||
    !(await publishGzipUsageCache(ref.path, material.encode(), MAX_COMPRESSED_BYTES))
  ) {
    await writeUsageSourceCacheData(ref, material.encode())
  }
}
