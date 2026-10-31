import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { threadId } from 'node:worker_threads'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../durable-file-write'

// Only scans need bulky per-source records; worker-owned sidecars keep them off main.

/** Where one provider's per-source scan cache lives, and whether this scan may start from it. */
export type UsageSourceCacheRef = {
  path: string
  schemaVersion: number
  worktreeFingerprint: string | null
  reuse: boolean
  hadPreviousHistory?: boolean
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
    const parsed = JSON.parse(await readFile(ref.path, 'utf-8'))
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

/** Keep event ownership through project changes; stale project/token projections must reparse. */
export async function readUsageSourceCacheForScan<T>(ref: UsageSourceCacheRef): Promise<{
  sources: T[]
  reuseProjections: boolean
  accountAttributionAvailable: boolean
}> {
  try {
    const parsed = JSON.parse(await readFile(ref.path, 'utf-8'))
    if (parsed?.schemaVersion !== ref.schemaVersion || !Array.isArray(parsed.sources)) {
      return { sources: [], reuseProjections: false, accountAttributionAvailable: false }
    }
    return {
      sources: parsed.sources,
      reuseProjections: ref.reuse && parsed.worktreeFingerprint === ref.worktreeFingerprint,
      accountAttributionAvailable: parsed.sources.length > 0 || ref.hadPreviousHistory !== true
    }
  } catch (error) {
    return {
      sources: [],
      reuseProjections: false,
      accountAttributionAvailable: isDefinitiveAbsence(error) && ref.hadPreviousHistory !== true
    }
  }
}

export async function writeUsageSourceCache(
  ref: UsageSourceCacheRef,
  sources: readonly unknown[]
): Promise<void> {
  await writeUsageSourceCacheText(
    ref,
    JSON.stringify({
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
  data: string | Uint8Array
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
  let text: string
  try {
    text = await readFile(request.cacheFile, 'utf-8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { reportText: null, migrated: false }
    }
    throw error
  }
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed[request.sourceKey])) {
    return { reportText: text, migrated: false }
  }
  const { [request.sourceKey]: sources, ...report } = parsed
  await writeUsageSourceCache(
    {
      path: usageSourceCachePath(request.cacheFile),
      schemaVersion: report.schemaVersion,
      worktreeFingerprint: report.worktreeFingerprint ?? null,
      reuse: true
    },
    sources
  )
  return { reportText: JSON.stringify(report), migrated: true }
}
