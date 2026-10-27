import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UsageCacheSnapshotWriter } from '../usage-cache-snapshot-writer'
import * as sourceCacheWriter from '../usage/usage-source-cache-file'
import { readClaudeUsageSourceCache, writeClaudeUsageSourceCache } from './persisted-source-cache'
import { serializeClaudeUsageReport } from './persisted-usage-report'
import {
  createPersistedUsageTestFixture,
  type PersistedUsageTestFixture
} from './persisted-usage-test-fixture'

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn<() => string>() }))
vi.mock('electron', () => ({ app: { getPath } }))
vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanClaudeUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))
vi.mock('./transcript-file-discovery', () => ({
  listClaudeTranscriptFiles: vi.fn(),
  claudeProfileTranscriptDirs: vi.fn(() => [])
}))

let fixture: PersistedUsageTestFixture

beforeEach(async () => {
  fixture = await createPersistedUsageTestFixture(getPath)
})

afterEach(async () => {
  await fixture.cleanup()
})

it('resumes an older source generation independently of a newer report', async () => {
  const original = await fixture.writeResumable()
  await appendFile(fixture.transcript, fixture.row(0, true))
  const updated = await fixture.project()
  await writeClaudeUsageSourceCache({ ...fixture.sourceRef, schemaVersion: 6 }, [original])
  await writeFile(fixture.reportPath, serializeClaudeUsageReport(fixture.state([updated], 7)))

  const store = fixture.createStore()
  await store.whenLoaded()
  expect(store.getSnapshot('all', 'all').summary.inputTokens).toBe(2000)
  expect(await fixture.decodedSources()).toEqual([original])
  expect(fixture.splitWorker).not.toHaveBeenCalled()
  await store.refresh(true)
  await store.flush()
  expect(await fixture.decodedSources()).toEqual([updated])
  expect(store.getSnapshot('all', 'all').summary).toMatchObject({ turns: 1, inputTokens: 2000 })
  expect(JSON.parse(await readFile(fixture.sourceRef.path, 'utf8')).schemaVersion).toBe(7)
})

it('uses a newer source generation independently of an older report', async () => {
  const original = await fixture.writeResumable()
  await appendFile(fixture.transcript, fixture.row(0, true))
  const updated = await fixture.project()
  await writeClaudeUsageSourceCache(fixture.sourceRef, [updated])
  await writeFile(fixture.reportPath, serializeClaudeUsageReport(fixture.state([original], 6)))

  const store = fixture.createStore()
  await store.whenLoaded()
  expect(store.getSnapshot('all', 'all').summary.inputTokens).toBe(1000)
  expect(await fixture.decodedSources()).toEqual([updated])
  expect(fixture.splitWorker).not.toHaveBeenCalled()
  await store.refresh(true)
  await store.flush()
  expect(await fixture.decodedSources()).toEqual([updated])
  expect(store.getSnapshot('all', 'all').summary).toMatchObject({ turns: 1, inputTokens: 2000 })
  expect(JSON.parse(await readFile(fixture.reportPath, 'utf8')).schemaVersion).toBe(7)
})

it('keeps a newer source generation when an earlier report migration could not be written', async () => {
  const original = await fixture.writeResumable()
  const inline = fixture.state([original])
  await writeFile(fixture.reportPath, JSON.stringify(inline))
  vi.spyOn(UsageCacheSnapshotWriter.prototype, 'write').mockRejectedValueOnce(
    new Error('report migration write failed')
  )
  const first = fixture.createStore()
  await first.whenLoaded()
  expect(JSON.parse(await readFile(fixture.reportPath, 'utf8'))).toEqual(inline)
  expect(await fixture.decodedSources()).toEqual([original])

  await appendFile(fixture.transcript, fixture.row(0, true))
  const updated = await fixture.project()
  await writeClaudeUsageSourceCache(fixture.sourceRef, [updated])
  const warmSourceText = await readFile(fixture.sourceRef.path, 'utf8')
  const restarted = fixture.createStore()
  await restarted.whenLoaded()
  expect(await readFile(fixture.sourceRef.path, 'utf8')).toBe(warmSourceText)
  expect(await fixture.decodedSources()).toEqual([updated])
  expect(restarted.getSnapshot('all', 'all').summary.inputTokens).toBe(1000)
  await restarted.refresh(true)
  await restarted.flush()
  expect(await fixture.decodedSources()).toEqual([updated])
  expect(restarted.getSnapshot('all', 'all').summary).toMatchObject({ turns: 1, inputTokens: 2000 })
})

it('preserves a disabled inline cache through worker failure and preference writes', async () => {
  const original = await fixture.writeResumable()
  const inline = fixture.state([original])
  inline.scanState.enabled = false
  await writeFile(fixture.reportPath, JSON.stringify(inline))
  fixture.splitWorker.mockRejectedValue(new Error('worker unavailable'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  const store = fixture.createStore()
  await store.whenLoaded()
  expect(store.getSnapshot('all', 'all')).toMatchObject({
    summary: { inputTokens: 1000 },
    scanState: { enabled: false }
  })
  await store.setEnabled(true)
  await store.flush()
  expect(JSON.parse(await readFile(fixture.reportPath, 'utf8'))).toEqual({
    ...inline,
    scanState: { ...inline.scanState, enabled: true }
  })
  expect(fixture.scanWorker).not.toHaveBeenCalled()
  expect((await readClaudeUsageSourceCache(fixture.sourceRef)).sources).toEqual([])

  await store.refresh(true)
  await store.flush()
  const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
  expect(report.schemaVersion).toBe(7)
  expect(report).not.toHaveProperty('processedFiles')
  expect(report.scanState.enabled).toBe(true)
  expect(await fixture.decodedSources()).toEqual([original])
})

it('rejects an unsigned schema7 tiny-file source without hiding its valid report', async () => {
  await writeFile(fixture.transcript, fixture.row(0))
  const original = await fixture.project()
  expect(original.parseResumeState).toBeNull()
  await writeClaudeUsageSourceCache(fixture.sourceRef, [original])
  await writeFile(fixture.reportPath, serializeClaudeUsageReport(fixture.state([original], 7)))
  const unsigned = JSON.parse(await readFile(fixture.sourceRef.path, 'utf8'))
  delete unsigned.usageIntegrity
  unsigned.sources[0].sessions[0].totalInputTokens = 9999
  unsigned.sources[0].dailyAggregates[0].inputTokens = 9999
  await writeFile(fixture.sourceRef.path, JSON.stringify(unsigned))
  expect((await readClaudeUsageSourceCache(fixture.sourceRef)).sources).toEqual([])

  const store = fixture.createStore()
  await store.whenLoaded()
  expect(store.getSnapshot('all', 'all').summary.inputTokens).toBe(1000)
  await store.refresh(true)
  await store.flush()
  expect(await fixture.decodedSources()).toEqual([original])
  expect(store.getSnapshot('all', 'all').summary).toMatchObject({ turns: 1, inputTokens: 1000 })
})

it('rejects a source cache attributed to a different worktree fingerprint', async () => {
  const original = await fixture.writeResumable()
  await writeClaudeUsageSourceCache(
    { ...fixture.sourceRef, worktreeFingerprint: '["other-worktree"]' },
    [original]
  )
  await writeFile(fixture.reportPath, serializeClaudeUsageReport(fixture.state([original], 7)))
  expect((await readClaudeUsageSourceCache(fixture.sourceRef)).sources).toEqual([])
  const store = fixture.createStore()
  await store.whenLoaded()
  await store.refresh(true)
  await store.flush()
  expect(await fixture.decodedSources()).toEqual([original])
  expect(store.getSnapshot('all', 'all').summary.inputTokens).toBe(1000)
})

it('updates the completed report while retaining an unchanged verified sidecar', async () => {
  const original = await fixture.writeResumable()
  await writeClaudeUsageSourceCache(fixture.sourceRef, [original])
  const state = fixture.state([original], 7)
  state.scanState.lastScanCompletedAt = 1
  await writeFile(fixture.reportPath, serializeClaudeUsageReport(state))
  const sourceText = await readFile(fixture.sourceRef.path, 'utf8')
  const write = vi.spyOn(sourceCacheWriter, 'writeUsageSourceCacheData')
  const store = fixture.createStore()
  await store.whenLoaded()

  await store.refresh(true)
  await store.flush()

  expect(write).not.toHaveBeenCalled()
  expect(await readFile(fixture.sourceRef.path, 'utf8')).toBe(sourceText)
  const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
  expect(report.scanState.lastScanCompletedAt).toBeGreaterThan(1)
  expect(store.getSnapshot('all', 'all').summary.inputTokens).toBe(1000)
})
