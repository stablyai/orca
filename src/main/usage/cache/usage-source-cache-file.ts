import { mkdir } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { threadId } from 'node:worker_threads'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable,
  type DurableFilePayload
} from '../../filesystem/durable-file-write'
import { encodeUsageCacheJson, parseUsageCacheJson, readUsageCacheJson } from './usage-cache-json'
import { decodedUsageCacheText, publishGzipUsageCache } from './usage-cache-gzip'
import { reattributeUsageSourcesForWorktrees } from '../worktree-attribution/usage-attribution-invalidation'

// Only scans need bulky per-source records; worker-owned sidecars keep them off main.

/** Where one provider's per-source scan cache lives, and the worktrees this scan attributes against. */
export type UsageSourceCacheRef = {
  path: string
  schemaVersion: number
  worktreeFingerprint: string | null
}

export type UsageCacheSplitRequest = { cacheFile: string; sourceKey: string; providerId?: 'claude' }
export type UsageCacheSplitResult = {
  reportText: string | null
  migrated: boolean
  reportIntegrityVerified?: boolean
}

export function usageSourceCachePath(cacheFile: string): string {
  const { dir, name } = parse(cacheFile)
  return join(dir, `${name}-sources.json`)
}

/** The last scan's records still attributed correctly; none when unreadable or from another schema. */
export async function readUsageSourceCache<T>(ref: UsageSourceCacheRef): Promise<T[]> {
  try {
    const parsed = await parseUsageCacheJson<{
      schemaVersion: number
      worktreeFingerprint: string | null
      sources: T[]
    }>(decodedUsageCacheText(ref.path))
    if (parsed?.schemaVersion !== ref.schemaVersion || !Array.isArray(parsed.sources)) {
      return []
    }
    // The sidecar can commit before its report, so validate attribution against its own fingerprint.
    return await reattributeUsageSourcesForWorktrees(
      parsed.sources.filter(isSourceRecord),
      typeof parsed.worktreeFingerprint === 'string' ? parsed.worktreeFingerprint : null,
      ref.worktreeFingerprint
    )
  } catch {
    return []
  }
}

// One unreadable entry would otherwise fail every later scan, since a failed scan never rewrites the sidecar.
function isSourceRecord(source: unknown): boolean {
  return typeof source === 'object' && source !== null && !Array.isArray(source)
}

export async function writeUsageSourceCache(
  ref: UsageSourceCacheRef,
  sources: readonly unknown[]
): Promise<void> {
  const encode = () =>
    encodeUsageCacheJson({
      schemaVersion: ref.schemaVersion,
      worktreeFingerprint: ref.worktreeFingerprint,
      sources
    })
  if (!(await publishGzipUsageCache(ref.path, encode()))) {
    await writeUsageSourceCacheData(ref, encode())
  }
}

export async function writeUsageSourceCacheText(
  ref: UsageSourceCacheRef,
  text: string
): Promise<void> {
  await writeUsageSourceCacheData(ref, text)
}

export async function writeUsageSourceCacheData(
  ref: UsageSourceCacheRef,
  data: DurableFilePayload
): Promise<void> {
  await mkdir(dirname(ref.path), { recursive: true }).catch(() => {})
  // Reclaim old durable-write temps left by workers terminated mid-write.
  await removeStaleDurableWriteTempFiles(ref.path)
  await writeFileDurable(
    durableWriteTempPath(ref.path, threadId > 0 ? String(threadId) : undefined),
    ref.path,
    data,
    0o600
  )
}

/** Move legacy inline source records to the sidecar so main parses only the compact report. */
export async function splitUsageCacheFile(
  request: UsageCacheSplitRequest
): Promise<UsageCacheSplitResult> {
  let parsed: Record<string, unknown> | null
  try {
    parsed = await readUsageCacheJson<Record<string, unknown>>(request.cacheFile)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { reportText: null, migrated: false }
    }
    throw error
  }
  const sources = parsed?.[request.sourceKey]
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(sources)) {
    return { reportText: JSON.stringify(parsed), migrated: false }
  }
  const { [request.sourceKey]: _sources, ...report } = parsed
  await writeUsageSourceCache(
    {
      path: usageSourceCachePath(request.cacheFile),
      schemaVersion: typeof report.schemaVersion === 'number' ? report.schemaVersion : 0,
      worktreeFingerprint:
        typeof report.worktreeFingerprint === 'string' ? report.worktreeFingerprint : null
    },
    sources
  )
  return { reportText: JSON.stringify(report), migrated: true }
}
