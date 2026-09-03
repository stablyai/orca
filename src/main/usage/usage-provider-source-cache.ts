import { existsSync, readFileSync } from 'node:fs'

type UsageSourceCacheEnvelope<SourceKey extends string> = {
  schemaVersion: number
  worktreeFingerprint: string | null
} & Record<SourceKey, unknown[]>

export function resolveUsageSourceCacheFile(cacheFile: string): string {
  return cacheFile.endsWith('.json')
    ? `${cacheFile.slice(0, -'.json'.length)}-sources.json`
    : `${cacheFile}.sources.json`
}

export function loadUsageSourceCache<SourceKey extends string>(params: {
  cacheFile: string
  sourceKey: SourceKey
  schemaVersion: number
  worktreeFingerprint: string | null
  logTag: string
}): unknown[] | null {
  const sourceFile = resolveUsageSourceCacheFile(params.cacheFile)
  if (!existsSync(sourceFile)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(sourceFile, 'utf-8')) as Partial<
      UsageSourceCacheEnvelope<SourceKey>
    >
    if (
      parsed.schemaVersion !== params.schemaVersion ||
      parsed.worktreeFingerprint !== params.worktreeFingerprint ||
      !Array.isArray(parsed[params.sourceKey])
    ) {
      return null
    }
    return parsed[params.sourceKey] as unknown[]
  } catch (error) {
    console.error(`${params.logTag} Failed to load usage source cache, rebuilding:`, error)
    return null
  }
}

export function serializeUsageSourceCache<SourceKey extends string>(params: {
  sourceKey: SourceKey
  schemaVersion: number
  worktreeFingerprint: string | null
  sources: unknown[]
  jsonIndent?: number
}): string {
  return JSON.stringify(
    {
      schemaVersion: params.schemaVersion,
      worktreeFingerprint: params.worktreeFingerprint,
      [params.sourceKey]: params.sources
    },
    null,
    params.jsonIndent
  )
}
