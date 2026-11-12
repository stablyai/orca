import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { splitUsageCacheFile, usageSourceCachePath } from './usage-source-cache-file'

describe('usage source cache file', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-usage-source-cache-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
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
})
