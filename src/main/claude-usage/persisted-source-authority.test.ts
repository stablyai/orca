import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeUsagePersistedFile, ClaudeUsagePersistedState } from './types'
import { scanClaudeUsageFiles } from './scanner'
import { readClaudeUsageScanFile } from './transcript-record-parser'
import { projectClaudeUsageScanFile } from './transcript-usage-projection'
import { parseClaudeUsageReport, serializeClaudeUsageReport } from './persisted-usage-report'
import {
  readClaudeUsageSourceCache,
  splitClaudeUsageCacheFile,
  writeClaudeUsageSourceCache
} from './persisted-source-cache'
import { sealUsageCacheJson } from '../usage/usage-cache-json-integrity'
import {
  compressClaudeUsageSourceText,
  decodeClaudeUsageSourceText
} from './source-cache-compression'
import { readUsageSourceCache } from '../usage/usage-source-cache-file'

const { discovered } = vi.hoisted(() => {
  const discovered: { paths: string[] } = { paths: [] }
  return { discovered }
})
vi.mock('./transcript-file-discovery', () => ({
  listClaudeTranscriptFiles: async () => discovered.paths
}))

let directory: string
let transcript: string
let sourcePath: string

function row(input: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'authority',
    requestId: 'request',
    timestamp: '2026-10-09T12:00:00.000Z',
    message: { id: 'message', usage: { input_tokens: input, output_tokens: 2 } }
  })}\n`
}

function ref() {
  return { path: sourcePath, schemaVersion: 7, worktreeFingerprint: '[]', reuse: true }
}

function state(file: ClaudeUsagePersistedFile, schemaVersion = 7): ClaudeUsagePersistedState {
  return {
    schemaVersion,
    worktreeFingerprint: '[]',
    processedFiles: [file],
    sessions: structuredClone(file.sessions),
    dailyAggregates: structuredClone(file.dailyAggregates),
    scanState: { enabled: false, lastScanStartedAt: 1, lastScanCompletedAt: 2, lastScanError: null }
  }
}

async function fixture(large = true): Promise<ClaudeUsagePersistedFile> {
  await writeFile(
    transcript,
    `${large ? `${JSON.stringify({ type: 'user', text: 'x'.repeat(20_000) })}\n` : ''}${row(100)}`
  )
  return projectClaudeUsageScanFile(
    await readClaudeUsageScanFile(transcript),
    new Map(),
    () => true
  )
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-source-authority-'))
  transcript = join(directory, 'session.jsonl')
  sourcePath = join(directory, 'usage-sources.json')
  discovered.paths = [transcript]
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('uses a verified packed restart for exact append corrections', async () => {
  const original = await fixture()
  await writeClaudeUsageSourceCache(ref(), [original])
  const cached = await readClaudeUsageSourceCache(ref())
  expect(cached.sources).toEqual([original])
  expect(cached.verifiedSources?.has(cached.sources[0])).toBe(true)
  await appendFile(transcript, row(150))

  const resumed = await scanClaudeUsageFiles(
    [],
    cached.sources,
    undefined,
    [],
    cached.verifiedSources
  )
  const cold = await scanClaudeUsageFiles([], [], undefined, [])

  expect(resumed.sessions).toEqual(cold.sessions)
  expect(resumed.dailyAggregates).toEqual(cold.dailyAggregates)
  expect(resumed.sessions[0]?.turnCount).toBe(1)
  expect(resumed.sessions[0]?.totalInputTokens).toBe(150)
})

it('compresses large caches losslessly and resumes the same totals after restart', async () => {
  const rows = Array.from({ length: 3000 }, (_, index) =>
    row(index).replace('"request"', `"request-${index}"`)
  ).join('')
  await writeFile(transcript, rows)
  const cold = await scanClaudeUsageFiles([], [], undefined, [])
  const mutableRef = ref()
  const pending = writeClaudeUsageSourceCache(mutableRef, cold.processedFiles)
  mutableRef.path = join(directory, 'different-cache.json')
  mutableRef.worktreeFingerprint = '["different-workspace"]'
  await pending
  await expect(readFile(mutableRef.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const text = await readFile(sourcePath)
  expect([...text.subarray(0, 2)]).toEqual([0x1f, 0x8b])
  const decoded = await decodeClaudeUsageSourceText(text)
  expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(decoded))
  const cached = await readClaudeUsageSourceCache(ref())
  expect(cached.sources).toEqual(cold.processedFiles)
  expect(cached.verifiedSources?.has(cached.sources[0])).toBe(true)

  await appendFile(transcript, row(4000).replace('"request"', '"request-7"'))
  const resumed = await scanClaudeUsageFiles(
    [],
    cached.sources,
    undefined,
    [],
    cached.verifiedSources
  )
  expect(resumed).toEqual(await scanClaudeUsageFiles([], [], undefined, []))
  // Older readers discard the optional resume cache; the separately stored report stays readable.
  expect(await readUsageSourceCache(ref())).toEqual([])
})

it('keeps old plain caches readable and rejects compressed content with invalid integrity', async () => {
  await writeFile(
    transcript,
    Array.from({ length: 3000 }, (_, index) =>
      row(index).replace('"request"', `"request-${index}"`)
    ).join('')
  )
  const cold = await scanClaudeUsageFiles([], [], undefined, [])
  await writeClaudeUsageSourceCache(ref(), cold.processedFiles)
  const decoded = await decodeClaudeUsageSourceText(await readFile(sourcePath))
  await writeFile(sourcePath, decoded)
  expect((await readClaudeUsageSourceCache(ref())).sources).toEqual(cold.processedFiles)
  const report = serializeClaudeUsageReport(state(cold.processedFiles[0]))
  const damaged = JSON.parse(decoded)
  damaged.sources[0].sessions[0].totalInputTokens++
  await writeFile(sourcePath, await compressClaudeUsageSourceText(JSON.stringify(damaged)))
  expect(await readClaudeUsageSourceCache(ref())).toEqual({ sources: [] })
  expect(await parseClaudeUsageReport(report, JSON.parse(report))).toEqual(JSON.parse(report))
})

it('protects tiny source rollups despite their absent resume checkpoint', async () => {
  const original = await fixture(false)
  expect(original.parseResumeState).toBeNull()
  await writeClaudeUsageSourceCache(ref(), [original])
  const saved = JSON.parse(await readFile(sourcePath, 'utf8'))
  saved.sources[0].sessions[0].totalInputTokens++
  await writeFile(sourcePath, JSON.stringify(saved))

  const rejected = await readClaudeUsageSourceCache(ref())
  expect(rejected.sources).toEqual([])
  const rebuilt = await scanClaudeUsageFiles([], rejected.sources, undefined, [])
  expect(rebuilt.sessions).toEqual(original.sessions)
})

it('rejects same-stat direct scanner corruption without a raw-envelope proof', async () => {
  const original = await fixture()
  const checkpoint = original.parseResumeState
  if (!checkpoint) {
    throw new Error('Expected a resumable fixture.')
  }
  checkpoint.ownedTokenMaxima[0][0]--
  const forged = { ...original, usageIntegrity: 'pretend-proof', schemaVersion: 7 }

  const rebuilt = await scanClaudeUsageFiles([], [forged], undefined, [])

  expect(rebuilt.sessions[0]?.totalInputTokens).toBe(100)
  expect(rebuilt.sessions[0]?.turnCount).toBe(1)
})

it.each(['missing', 'null', 'number', 'pretty', 'domain'] as const)(
  'starts cold for %s source framing',
  async (corruption) => {
    const original = await fixture()
    await writeClaudeUsageSourceCache(ref(), [original])
    const text = await readFile(sourcePath, 'utf8')
    const saved = JSON.parse(text)
    if (corruption === 'missing') {
      delete saved.usageIntegrity
    }
    if (corruption === 'null') {
      saved.usageIntegrity = null
    }
    if (corruption === 'number') {
      saved.usageIntegrity = 7
    }
    const damaged =
      corruption === 'domain'
        ? serializeClaudeUsageReport(state(original))
        : JSON.stringify(saved, null, corruption === 'pretty' ? 2 : undefined)
    await writeFile(sourcePath, damaged)

    expect((await readClaudeUsageSourceCache(ref())).sources).toEqual([])
  }
)

it('does not present a corrupt future completion as fresh report history', async () => {
  const original = await fixture()
  const saved = JSON.parse(serializeClaudeUsageReport(state(original)))
  saved.scanState.lastScanCompletedAt = Date.now() + 86_400_000

  const rejected = await parseClaudeUsageReport(JSON.stringify(saved))

  expect(rejected.sessions).toEqual([])
  expect(rejected.scanState).toMatchObject({ enabled: false, lastScanCompletedAt: null })
  expect(rejected.scanState.lastScanError).toContain('could not be validated')
})

it('retains genuine unsigned schema6 reports without promoting their lineage', async () => {
  const original = await fixture(false)
  const legacy = state(original, 6)
  const text = serializeClaudeUsageReport(legacy)

  expect(text).not.toContain('usageIntegrity')
  expect(await parseClaudeUsageReport(text)).toMatchObject({
    schemaVersion: 6,
    sessions: original.sessions
  })
})

it('does not seal arbitrary unprotected schema7 inline totals during migration', async () => {
  const original = await fixture(false)
  const cacheFile = join(directory, 'usage.json')
  await writeFile(cacheFile, JSON.stringify(state(original)))

  const split = await splitClaudeUsageCacheFile({
    cacheFile,
    sourceKey: 'processedFiles',
    providerId: 'claude'
  })
  const report = await parseClaudeUsageReport(split.reportText ?? '')

  expect(report.sessions).toEqual([])
  expect(report.scanState).toMatchObject({ enabled: false, lastScanCompletedAt: null })
  expect(report.scanState.lastScanError).toContain('could not be validated')
})

it('rejects a source envelope stamped for an unsupported producer schema', async () => {
  const original = await fixture()
  const material = JSON.stringify({
    schemaVersion: 6,
    worktreeFingerprint: '[]',
    sources: [original]
  })
  await writeFile(sourcePath, sealUsageCacheJson(material, 'claude-usage-sources-v1'))
  expect((await readClaudeUsageSourceCache(ref())).sources).toEqual([])
})

it('rejects empty-object integrity material rather than emitting invalid JSON', () => {
  expect(() => sealUsageCacheJson('{}', 'test')).toThrow('requires a JSON object')
})
