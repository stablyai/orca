import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readUsageSourceCache,
  splitUsageCacheFile,
  usageSourceCachePath,
  writeUsageSourceCache,
  type UsageSourceCacheRef
} from './usage-source-cache-file'

describe('usage source cache file', () => {
  let directory: string
  let ref: UsageSourceCacheRef

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-usage-source-cache-'))
    ref = {
      path: join(directory, 'usage-sources.json'),
      schemaVersion: 6,
      worktreeFingerprint: '[]',
      reuse: true
    }
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('names the sidecar after the report it belongs to', () => {
    expect(usageSourceCachePath(join(directory, 'orca-claude-usage.json'))).toBe(
      join(directory, 'orca-claude-usage-sources.json')
    )
  })

  it('round-trips the records a scan wrote', async () => {
    await writeUsageSourceCache(ref, [{ path: 'a.jsonl' }])

    await expect(readUsageSourceCache(ref)).resolves.toEqual([{ path: 'a.jsonl' }])
  })

  it('rejects attribution from a sidecar committed ahead of its report', async () => {
    await writeUsageSourceCache({ ...ref, worktreeFingerprint: 'new-worktrees' }, [
      { path: 'a.jsonl', repoId: 'new-repo' }
    ])

    await expect(
      readUsageSourceCache({ ...ref, worktreeFingerprint: 'old-worktrees' })
    ).resolves.toEqual([])
    await expect(
      readUsageSourceCache({ ...ref, worktreeFingerprint: 'new-worktrees' })
    ).resolves.toEqual([{ path: 'a.jsonl', repoId: 'new-repo' }])
  })

  it('starts cold when told not to reuse, on another schema, or on a torn file', async () => {
    await writeUsageSourceCache(ref, [{ path: 'a.jsonl' }])

    await expect(readUsageSourceCache({ ...ref, reuse: false })).resolves.toEqual([])
    await expect(readUsageSourceCache({ ...ref, schemaVersion: 7 })).resolves.toEqual([])
    writeFileSync(ref.path, '{"schemaVersion":6,"sources":[')
    await expect(readUsageSourceCache(ref)).resolves.toEqual([])
    await expect(
      readUsageSourceCache({ ...ref, path: join(directory, 'none.json') })
    ).resolves.toEqual([])
  })

  it('moves inline records of a legacy cache into the sidecar and returns only the report', async () => {
    const cacheFile = join(directory, 'orca-claude-usage.json')
    const legacy = {
      schemaVersion: 6,
      worktreeFingerprint: '[]',
      processedFiles: [{ path: 'a.jsonl' }],
      sessions: [{ sessionId: 's' }]
    }
    writeFileSync(cacheFile, JSON.stringify(legacy, null, 2))

    const result = await splitUsageCacheFile({ cacheFile, sourceKey: 'processedFiles' })

    expect(result.migrated).toBe(true)
    expect(JSON.parse(result.reportText ?? '')).toEqual({
      schemaVersion: 6,
      worktreeFingerprint: '[]',
      sessions: [{ sessionId: 's' }]
    })
    expect(JSON.parse(readFileSync(usageSourceCachePath(cacheFile), 'utf-8'))).toEqual({
      schemaVersion: 6,
      worktreeFingerprint: '[]',
      sources: [{ path: 'a.jsonl' }]
    })
  })

  it('returns a report that is already split unchanged and leaves the sidecar alone', async () => {
    const cacheFile = join(directory, 'orca-claude-usage.json')
    const text = JSON.stringify({ schemaVersion: 6, sessions: [] })
    writeFileSync(cacheFile, text)

    await expect(splitUsageCacheFile({ cacheFile, sourceKey: 'processedFiles' })).resolves.toEqual({
      reportText: text,
      migrated: false
    })
    expect(existsSync(usageSourceCachePath(cacheFile))).toBe(false)
  })

  it('reports a missing cache as no report rather than an error', async () => {
    await expect(
      splitUsageCacheFile({
        cacheFile: join(directory, 'missing.json'),
        sourceKey: 'processedFiles'
      })
    ).resolves.toEqual({ reportText: null, migrated: false })
  })
})
