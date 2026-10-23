import { readFile } from 'node:fs/promises'
import type { ClaudeUsagePersistedFile, ClaudeUsagePersistedState } from './types'
import { encodeClaudeUsagePersistedFiles } from './persisted-token-columns'
import {
  compressClaudeUsageSourceText,
  decodeClaudeUsageSourceText
} from './source-cache-compression'
import {
  hasClaudeUsageProtectedCheckpoint,
  normalizeClaudeUsageSourceFiles,
  type ClaudeUsageVerifiedSources
} from './persisted-projection-validation'
import { parseClaudeUsageReport, serializeClaudeUsageReport } from './persisted-usage-report'
import { sealUsageCacheJson, verifyUsageCacheJson } from '../usage/usage-cache-json-integrity'
import {
  usageSourceCachePath,
  writeUsageSourceCacheData,
  type UsageCacheSplitRequest,
  type UsageCacheSplitResult,
  type UsageSourceCacheRef
} from '../usage/usage-source-cache-file'

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
    const text = await decodeClaudeUsageSourceText(await readFile(cacheRef.path))
    const parsed = JSON.parse(text)
    const verified = verifyUsageCacheJson(text, parsed?.usageIntegrity, SOURCE_DOMAIN)
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
  const material = JSON.stringify({
    schemaVersion: cacheRef.schemaVersion,
    worktreeFingerprint: cacheRef.worktreeFingerprint,
    sources: encodeClaudeUsagePersistedFiles(sources)
  })
  await writeUsageSourceCacheData(
    cacheRef,
    await compressClaudeUsageSourceText(
      cacheRef.schemaVersion === 6 ? material : sealUsageCacheJson(material, SOURCE_DOMAIN)
    )
  )
}

export async function splitClaudeUsageCacheFile(
  request: UsageCacheSplitRequest
): Promise<UsageCacheSplitResult> {
  let text: string
  try {
    text = await readFile(request.cacheFile, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { reportText: null, migrated: false }
    }
    throw error
  }
  const parsed: ClaudeUsagePersistedState = JSON.parse(text)
  if (!Array.isArray(parsed.processedFiles) || parsed.processedFiles.length === 0) {
    const validated = await parseClaudeUsageReport(text, parsed)
    return {
      reportText: validated === parsed ? text : serializeClaudeUsageReport(validated),
      migrated: false,
      reportIntegrityVerified: validated.schemaVersion === 7
    }
  }
  const validated = await parseClaudeUsageReport(text, parsed)
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
