import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { projectClaudeUsageScanFile } from './transcript-usage-projection'
import { readClaudeUsageScanFile } from './transcript-record-parser'
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
const KEY_COUNT = 1024

beforeEach(async () => {
  fixture = await createPersistedUsageTestFixture(getPath)
})

afterEach(async () => {
  await fixture.cleanup()
})

it('persists every distinct maximum within the sidecar byte budget and resumes an older indented cache', async () => {
  await writeFile(
    fixture.transcript,
    Array.from({ length: KEY_COUNT }, (_, index) => fixture.row(index)).join('')
  )
  const initial = await fixture.project()
  const store = fixture.createStore()
  await store.setEnabled(true)
  await store.refresh(true)
  await store.flush()

  const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
  const sourceText = await readFile(fixture.sourceRef.path, 'utf8')
  const sidecar = JSON.parse(sourceText)
  expect(report.schemaVersion).toBe(7)
  expect(report).not.toHaveProperty('processedFiles')
  expect(report.sessions).toEqual(initial.sessions)
  expect(Buffer.byteLength(sourceText)).toBeLessThan(100_000)
  expect(sidecar.schemaVersion).toBe(7)
  expect(sidecar.sources[0]?.parseResumeState).not.toHaveProperty('ownedTokenMaxima')
  expect(sidecar.sources[0]?.parseResumeState.tokenCodecVersion).toBe(1)
  expect(await fixture.decodedSources()).toEqual([initial])
  expect(initial.ownedDedupeKeys).toHaveLength(KEY_COUNT)
  expect(initial.parseResumeState?.ownedTokenMaxima).toHaveLength(KEY_COUNT)

  await rm(fixture.sourceRef.path)
  await writeFile(fixture.reportPath, JSON.stringify(fixture.state([initial]), null, 2))
  await appendFile(fixture.transcript, fixture.row(0, true))
  const restarted = fixture.createStore()
  await restarted.whenLoaded()
  const migrated = JSON.parse(await readFile(fixture.sourceRef.path, 'utf8'))
  expect(migrated.schemaVersion).toBe(7)
  expect(migrated.sources[0]?.parseResumeState.tokenCodecVersion).toBe(1)
  expect(await fixture.decodedSources()).toEqual([initial])
  await restarted.refresh(true)
  await restarted.flush()

  const afterRestart = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
  const cold = await fixture.project()
  expect(afterRestart.schemaVersion).toBe(7)
  expect(afterRestart).not.toHaveProperty('processedFiles')
  expect(afterRestart.sessions).toEqual(cold.sessions)
  expect(afterRestart.dailyAggregates).toEqual(cold.dailyAggregates)
  expect(await fixture.decodedSources()).toEqual([cold])
  expect(cold.ownedDedupeKeys).toHaveLength(KEY_COUNT)
  expect(cold.sessions[0]?.sessionId).toBe('original-session')
  expect(cold.sessions[0]?.turnCount).toBe(KEY_COUNT)
  expect(cold.parseResumeState?.ownedTokenMaxima[0]).toEqual([2000, 55, 5, 15, 3, 0])
})

it('hides invalid saved totals until a refresh rebuilds the owner and its deferred fork', async () => {
  const initial = await fixture.writeResumable()
  const forkPath = join(fixture.directory, 'fork.jsonl')
  await writeFile(forkPath, await readFile(fixture.transcript, 'utf8'))
  fixture.transcripts.push(forkPath)
  const fork = await projectClaudeUsageScanFile(
    await readClaudeUsageScanFile(forkPath),
    new Map(),
    () => false
  )
  expect(fork.hasDeferredClaims).toBe(true)
  const state = fixture.state([initial, fork])
  const maxima = initial.parseResumeState?.ownedTokenMaxima[0]
  if (!maxima) {
    throw new Error('Expected a resumable owner fixture.')
  }
  maxima[0]--
  await writeFile(fixture.reportPath, JSON.stringify(state))

  const store = fixture.createStore()
  await store.whenLoaded()
  expect(await fixture.decodedSources()).toEqual([])
  expect(store.getSnapshot('all', 'all')).toMatchObject({
    summary: { sessions: 0, turns: 0, inputTokens: 0 },
    daily: [],
    recentSessions: [],
    scanState: {
      enabled: true,
      hasAnyClaudeData: false,
      lastScanCompletedAt: null,
      lastScanError: 'Saved usage totals could not be validated. Refresh to rebuild them.'
    }
  })
  await store.refresh(false)
  await store.flush()
  expect(store.getSnapshot('all', 'all')).toMatchObject({
    summary: { sessions: 1, turns: 1, inputTokens: 1000 },
    scanState: { enabled: true, hasAnyClaudeData: true, lastScanError: null }
  })
  const rebuilt = await fixture.decodedSources()
  expect(rebuilt).toHaveLength(2)
  expect(rebuilt.flatMap((file) => file.ownedDedupeKeys)).toHaveLength(1)
  expect(rebuilt.some((file) => file.hasDeferredClaims)).toBe(true)
})

it('reconstructs duplicated global totals from validated file projections on load', async () => {
  const initial = await fixture.writeResumable()
  const state = fixture.state([initial])
  const session = state.sessions[0]
  const daily = state.dailyAggregates[0]
  if (!session || !daily) {
    throw new Error('Expected saved global totals.')
  }
  session.totalInputTokens++
  daily.inputTokens++
  await writeFile(fixture.reportPath, JSON.stringify(state))

  const store = fixture.createStore()
  await store.whenLoaded()
  expect(store.getSnapshot('all', 'all')).toMatchObject({
    summary: { sessions: 1, turns: 1, inputTokens: 1000 },
    daily: [{ inputTokens: 1000 }],
    scanState: { enabled: true, lastScanCompletedAt: state.scanState.lastScanCompletedAt }
  })
  await store.refresh(false)
  expect(fixture.scanWorker).not.toHaveBeenCalled()
})

it('retains both signed and older aggregate-only file totals when loading a fresh cache', async () => {
  const initial = await fixture.writeResumable()
  const legacyPath = join(fixture.directory, 'legacy.jsonl')
  await writeFile(legacyPath, fixture.row(1))
  const legacy = await projectClaudeUsageScanFile(
    await readClaudeUsageScanFile(legacyPath),
    new Map(),
    () => true
  )
  delete legacy.parseResumeState
  const state = fixture.state([initial, legacy])
  await writeFile(fixture.reportPath, JSON.stringify(state))

  const store = fixture.createStore()
  await store.whenLoaded()
  expect(store.getSnapshot('all', 'all')).toMatchObject({
    summary: { sessions: 1, turns: 2, inputTokens: 2001 },
    daily: [{ inputTokens: 2001 }],
    scanState: { enabled: true, lastScanCompletedAt: state.scanState.lastScanCompletedAt }
  })
  expect(await fixture.decodedSources()).toEqual([initial, legacy])
  await store.refresh(false)
  expect(fixture.scanWorker).not.toHaveBeenCalled()
})

it.each(['nonArray', 'nullEntry', 'unsignedRollup'] as const)(
  'preserves tracking when malformed %s cache records cannot be validated',
  async (malformation) => {
    const initial = await fixture.writeResumable()
    const state = fixture.state([initial])
    const malformedFiles =
      malformation === 'nonArray'
        ? null
        : malformation === 'nullEntry'
          ? [initial, null]
          : [
              initial,
              {
                ...initial,
                parseResumeState: null,
                sessions: [{ ...initial.sessions[0], locationBreakdown: null }]
              }
            ]
    await writeFile(
      fixture.reportPath,
      JSON.stringify({ ...state, processedFiles: malformedFiles })
    )

    const store = fixture.createStore()
    await store.whenLoaded()
    expect(store.getSnapshot('all', 'all')).toMatchObject({
      summary: { sessions: 0, turns: 0 },
      daily: [],
      scanState: {
        enabled: true,
        hasAnyClaudeData: false,
        lastScanCompletedAt: null,
        lastScanError: 'Saved usage totals could not be validated. Refresh to rebuild them.'
      }
    })
  }
)
