import type { ClaudeUsagePersistedFile, ClaudeUsagePersistedState } from './types'
import { encodeClaudeUsagePersistedFiles } from './persisted-token-columns'
import { writeClaudeUsageJson, readClaudeUsageJson } from './source-cache-compression'
import {
  hasClaudeUsageProtectedCheckpoint,
  normalizeClaudeUsageSourceFiles,
  type ClaudeUsageVerifiedSources
} from './persisted-projection-validation'
import {
  parseClaudeUsageReport,
  readClaudeUsageReportFile,
  serializeClaudeUsageReport
} from './persisted-usage-report'
import {
  usageSourceCachePath,
  type UsageCacheSplitRequest,
  type UsageCacheSplitResult,
  type UsageSourceCacheRef
} from '../usage/cache/usage-source-cache-file'

const SOURCE_DOMAIN = 'claude-usage-sources-v1'

export type ClaudeUsageLoadedSourceCache = {
  sources: ClaudeUsagePersistedFile[]
  verifiedSources?: ClaudeUsageVerifiedSources
  unchangedSourceCache?: {
    ref: UsageSourceCacheRef
    sources: readonly ClaudeUsagePersistedFile[]
  }
}

export async function readClaudeUsageSourceCache(
  ref: UsageSourceCacheRef
): Promise<ClaudeUsageLoadedSourceCache> {
  const cacheRef = { ...ref }
  if (!cacheRef.reuse) {
    return { sources: [] }
  }
  try {
    const { parsed, verified } = await readClaudeUsageJson<{
      usageIntegrity?: string
      schemaVersion: number
      worktreeFingerprint: string | null
      sources: ClaudeUsagePersistedFile[]
    }>(cacheRef.path, SOURCE_DOMAIN)
    if (
      (parsed?.schemaVersion !== cacheRef.schemaVersion &&
        !(cacheRef.schemaVersion === 7 && parsed?.schemaVersion === 6)) ||
      parsed.worktreeFingerprint !== cacheRef.worktreeFingerprint ||
      !Array.isArray(parsed.sources) ||
      (parsed.schemaVersion === 7 && !verified) ||
      (parsed.schemaVersion === 6 && verified)
    ) {
      return { sources: [] }
    }
    if (verified) {
      const normalized = normalizeClaudeUsageSourceFiles(
        parsed.sources,
        new WeakSet(parsed.sources)
      )
      return {
        sources: normalized.processedFiles,
        verifiedSources: new WeakSet(normalized.processedFiles),
        unchangedSourceCache:
          !normalized.invalidated &&
          normalized.processedFiles.length === parsed.sources.length &&
          normalized.processedFiles.every((file, index) => file === parsed.sources[index])
            ? { ref: cacheRef, sources: [...normalized.processedFiles] }
            : undefined
      }
    }
    return { sources: parsed.sources }
  } catch {
    return { sources: [] }
  }
}

export async function persistClaudeUsageSourceCache(
  ref: UsageSourceCacheRef,
  sources: readonly ClaudeUsagePersistedFile[],
  previous: ClaudeUsageLoadedSourceCache
): Promise<void> {
  const unchanged = previous.unchangedSourceCache
  if (
    unchanged &&
    ref.reuse &&
    ref.schemaVersion === 7 &&
    ref.path === unchanged.ref.path &&
    ref.schemaVersion === unchanged.ref.schemaVersion &&
    ref.worktreeFingerprint === unchanged.ref.worktreeFingerprint &&
    sources.length === unchanged.sources.length &&
    sources.every((file, index) => file === unchanged.sources[index])
  ) {
    return
  }
  await writeClaudeUsageSourceCache(ref, sources)
}

export async function writeClaudeUsageSourceCache(
  ref: UsageSourceCacheRef,
  sources: readonly ClaudeUsagePersistedFile[]
): Promise<void> {
  const cacheRef = { ...ref }
  await writeClaudeUsageJson(
    cacheRef,
    {
      schemaVersion: cacheRef.schemaVersion,
      worktreeFingerprint: cacheRef.worktreeFingerprint,
      sources: encodeClaudeUsagePersistedFiles(sources)
    },
    SOURCE_DOMAIN,
    cacheRef.schemaVersion !== 6
  )
}

export async function splitClaudeUsageCacheFile(
  request: UsageCacheSplitRequest
): Promise<UsageCacheSplitResult> {
  let loaded: Awaited<ReturnType<typeof readClaudeUsageReportFile>>
  try {
    loaded = await readClaudeUsageReportFile(request.cacheFile)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { reportText: null, migrated: false }
    }
    throw error
  }
  const parsed: ClaudeUsagePersistedState = loaded.state
  if (!Array.isArray(parsed.processedFiles) || parsed.processedFiles.length === 0) {
    const validated = await parseClaudeUsageReport('', parsed, loaded.integrityVerified)
    return {
      reportText: serializeClaudeUsageReport(validated),
      migrated: false,
      reportIntegrityVerified: validated.schemaVersion === 7
    }
  }
  const validated = await parseClaudeUsageReport('', parsed, loaded.integrityVerified)
  const protectedInline = parsed.processedFiles.some(hasClaudeUsageProtectedCheckpoint)
  const state = protectedInline ? { ...validated, schemaVersion: 7 } : validated
  const ref = {
    path: usageSourceCachePath(request.cacheFile),
    schemaVersion: state.schemaVersion,
    worktreeFingerprint: state.worktreeFingerprint,
    reuse: true
  }
  const existing = await readClaudeUsageSourceCache({ ...ref, schemaVersion: 7 })
  // A newer sidecar can survive a failed report migration; do not replace its warm generation.
  if (!existing.verifiedSources) {
    await writeClaudeUsageSourceCache(ref, state.processedFiles)
  }
  return {
    reportText: serializeClaudeUsageReport(state),
    migrated: true,
    reportIntegrityVerified: state.schemaVersion === 7
  }
}
