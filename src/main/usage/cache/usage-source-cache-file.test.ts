import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readUsageSourceCache,
  splitUsageCacheFile,
  usageSourceCachePath,
  writeUsageSourceCache
} from './usage-source-cache-file'

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

  it('preserves large ownership records, JSON values and Unicode across encoded boundaries', async () => {
    const ref = {
      path: join(directory, 'sources.json'),
      schemaVersion: 7,
      worktreeFingerprint: 'w',
      reuse: true
    }
    const label = `${'a'.repeat(4095)}😀é\n"\\\u0000\ud800`
    const shared = { totalTokens: 29 }
    const sources = [
      {
        path: label,
        ownedEventKeys: Array.from({ length: 1600 }, () => label),
        hasDeferredClaims: true,
        parseResumeState: { parsedBytes: 123, headDigest: 'head', boundaryDigest: 'tail' },
        dailyAggregates: [shared, shared],
        optional: undefined,
        extra: [undefined, Infinity],
        packed: { toJSON: () => ({ ownedTokenColumns: [29, null] }) }
      }
    ]
    await writeUsageSourceCache(ref, sources)
    const saved = readFileSync(ref.path, 'utf8')
    expect(saved).not.toContain('optional')
    expect(JSON.parse(saved).sources[0].extra).toEqual([null, null])
    expect(await readUsageSourceCache(ref)).toEqual([
      {
        path: label,
        ownedEventKeys: Array.from({ length: 1600 }, () => label),
        hasDeferredClaims: true,
        parseResumeState: { parsedBytes: 123, headDigest: 'head', boundaryDigest: 'tail' },
        dailyAggregates: [{ totalTokens: 29 }, { totalTokens: 29 }],
        extra: [null, null],
        packed: { ownedTokenColumns: [29, null] }
      }
    ])

    const prefix = '{"schemaVersion":7,"worktreeFingerprint":"w","sources":[{"path":"'
    const padding = 'p'.repeat(65535 - Buffer.byteLength(prefix))
    writeFileSync(ref.path, `${prefix}${padding}😀é"}]}`)
    expect(await readUsageSourceCache(ref)).toEqual([{ path: `${padding}😀é` }])
  })

  it('never reuses a source prefix from a truncated or trailing-invalid document', async () => {
    const ref = {
      path: join(directory, 'sources.json'),
      schemaVersion: 7,
      worktreeFingerprint: 'w',
      reuse: true
    }
    const complete = '{"schemaVersion":7,"worktreeFingerprint":"w","sources":[{"tokens":29}]}'
    for (const text of [complete.slice(0, -1), `${complete} null`, `${complete} garbage`]) {
      writeFileSync(ref.path, text)
      expect(await readUsageSourceCache(ref)).toEqual([])
    }
  })

  it('keeps the prior cache and removes the partial temp when encoding fails after writing', async () => {
    const ref = {
      path: join(directory, 'sources.json'),
      schemaVersion: 7,
      worktreeFingerprint: 'w',
      reuse: true
    }
    await writeUsageSourceCache(ref, [{ totalTokens: 29 }])
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    await expect(
      writeUsageSourceCache(ref, [{ path: 'a'.repeat(2_000_000) }, cyclic])
    ).rejects.toThrow()
    expect(await readUsageSourceCache(ref)).toEqual([{ totalTokens: 29 }])
    expect(readdirSync(directory)).toEqual(['sources.json'])
  })
})
