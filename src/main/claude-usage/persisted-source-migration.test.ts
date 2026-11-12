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
