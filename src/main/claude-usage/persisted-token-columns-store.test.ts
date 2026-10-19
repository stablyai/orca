import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

it.each([
  { name: 'empty', checkpoint: {} },
  { name: 'offset-only', checkpoint: { parsedBytes: 20_000 } },
  {
    name: 'unsigned tuples',
    checkpoint: {
      parsedBytes: 20_000,
      lineCount: 1,
      boundaryDigest: 'boundary',
      headDigest: 'head',
      physicalFileId: '1:2',
      ownedTokenMaxima: [[100, 10, 0, 20, 5, null]],
      projections: [],
      encounterOrder: []
    }
  }
])(
  'preserves $name legacy checkpoints when enabling and flushing without a scan',
  async ({ checkpoint }) => {
    const file = {
      path: join(fixture.directory, 'legacy.jsonl'),
      mtimeMs: 1,
      ctimeMs: 2,
      physicalFileId: '1:2',
      size: 20_000,
      lineCount: 1,
      sessions: [],
      dailyAggregates: [],
      ownedDedupeKeys: ['legacy-key'],
      hasDeferredClaims: false,
      parseResumeState: checkpoint
    }
    const state = {
      schemaVersion: 6,
      worktreeFingerprint: '[]',
      processedFiles: [file],
      sessions: [],
      dailyAggregates: [],
      scanState: {
        enabled: false,
        lastScanStartedAt: 1,
        lastScanCompletedAt: 2,
        lastScanError: null
      }
    }
    await writeFile(fixture.reportPath, JSON.stringify(state))
    const store = fixture.createStore()
    await store.setEnabled(true)
    await store.flush()

    const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
    const sidecar = JSON.parse(await readFile(fixture.sourceRef.path, 'utf8'))
    expect(report).not.toHaveProperty('processedFiles')
    expect(report).not.toHaveProperty('usageIntegrity')
    expect(report.schemaVersion).toBe(6)
    expect(report.scanState).toEqual({ ...state.scanState, enabled: true })
    expect(sidecar.schemaVersion).toBe(6)
    expect(sidecar).not.toHaveProperty('usageIntegrity')
    expect(sidecar.sources).toEqual([file])
    expect(sidecar.sources[0]?.parseResumeState).not.toHaveProperty('tokenCodecVersion')
    expect(sidecar.sources[0]?.parseResumeState).not.toHaveProperty('ownedTokenColumns')
    expect(sidecar.sources[0]?.parseResumeState).not.toHaveProperty('projectionIntegrity')
    expect(fixture.scanWorker).not.toHaveBeenCalled()
  }
)
