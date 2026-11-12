import { sealUsageCacheJson } from '../usage/cache/usage-cache-json-integrity'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createPersistedUsageTestFixture,
  type PersistedUsageTestFixture
} from './persisted-usage-test-fixture'

vi.mock('./transcript-file-discovery', () => ({ listClaudeTranscriptFiles: vi.fn() }))
vi.mock('../usage/scan-worker/usage-scan-worker-spawn', () => ({
  scanClaudeUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))
let fixture: PersistedUsageTestFixture
beforeEach(async () => {
  fixture = await createPersistedUsageTestFixture()
})
afterEach(async () => {
  await fixture.cleanup()
})

it('preserves protected inline ownership through failed migration, toggle and retry', async () => {
  const source = await fixture.writeResumable()
  await writeFile(fixture.reportPath, JSON.stringify(fixture.state([source])))
  await mkdir(fixture.sourceRef.path)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const first = fixture.createStore()
  await first.whenLoaded()
  await first.setEnabled(false)
  await first.flush()
  const retained = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
  expect(retained.processedFiles).toEqual([source])
  expect(retained.scanState.enabled).toBe(false)
  await rm(fixture.sourceRef.path, { recursive: true })
  const retried = fixture.createStore()
  await retried.whenLoaded()
  await retried.flush()
  expect(retried.getScanState()).toMatchObject({ enabled: false, hasAnyClaudeData: true })
  expect(await fixture.decodedSources()).toEqual([source])
  expect(JSON.parse(await readFile(fixture.reportPath, 'utf8')).processedFiles).toBeUndefined()
})

it('does not trust a canonical reconstruction when original report verification failed', async () => {
  const source = await fixture.writeResumable()
  const { processedFiles: _files, ...report } = fixture.state([source], 7)
  const canonical = sealUsageCacheJson(
    JSON.stringify({ ...report, padding: 'a'.repeat(8 * 1024 * 1024) }),
    'claude-usage-report-v1'
  )
  await writeFile(fixture.reportPath, canonical.replace('{"usageIntegrity"', '{ "usageIntegrity"'))
  fixture.splitWorker.mockRejectedValueOnce(new Error('worker unavailable'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = fixture.createStore()
  await store.whenLoaded()
  expect(store.getScanState()).toMatchObject({ hasAnyClaudeData: false, lastScanCompletedAt: null })
  await store.flush()
})
