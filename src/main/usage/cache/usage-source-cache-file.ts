import { mkdir } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { threadId } from 'node:worker_threads'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable,
  type DurableFilePayload
} from '../../filesystem/durable-file-write'
import { encodeUsageCacheJson, readUsageCacheJson } from './usage-cache-json'

// Only scans need bulky per-source records; worker-owned sidecars keep them off main.

/** Where one provider's per-source scan cache lives, and whether this scan may start from it. */
export type UsageSourceCacheRef = {
  path: string
  schemaVersion: number
  worktreeFingerprint: string | null
  reuse: boolean
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

/** The last scan's records; none when unreadable or from another schema, so the scan starts cold. */
export async function readUsageSourceCache<T>(ref: UsageSourceCacheRef): Promise<T[]> {
  if (!ref.reuse) {
    return []
  }
  try {
    const parsed = await readUsageCacheJson<{
      schemaVersion: number
      worktreeFingerprint: string | null
      sources: T[]
    }>(ref.path)
    // The sidecar can commit before its report, so validate attribution independently.
    return parsed?.schemaVersion === ref.schemaVersion &&
      parsed.worktreeFingerprint === ref.worktreeFingerprint &&
      Array.isArray(parsed.sources)
      ? parsed.sources
      : []
  } catch {
    return []
  }
}

export async function writeUsageSourceCache(
  ref: UsageSourceCacheRef,
  sources: readonly unknown[]
): Promise<void> {
  await writeUsageSourceCacheData(
    ref,
    encodeUsageCacheJson({
      schemaVersion: ref.schemaVersion,
      worktreeFingerprint: ref.worktreeFingerprint,
      sources
    })
  )
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
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed[request.sourceKey])) {
    return { reportText: JSON.stringify(parsed), migrated: false }
  }
  const { [request.sourceKey]: sources, ...report } = parsed
  await writeUsageSourceCache(
    {
      path: usageSourceCachePath(request.cacheFile),
      schemaVersion: typeof report.schemaVersion === 'number' ? report.schemaVersion : 0,
      worktreeFingerprint:
        typeof report.worktreeFingerprint === 'string' ? report.worktreeFingerprint : null,
      reuse: true
    },
    sources
  )
  return { reportText: JSON.stringify(report), migrated: true }
}
