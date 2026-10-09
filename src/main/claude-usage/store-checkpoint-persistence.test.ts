import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { projectClaudeUsageScanFile } from './transcript-usage-projection'
import { readClaudeUsageScanFile } from './transcript-record-parser'
import type { ClaudeUsagePersistedFile, ClaudeUsagePersistedState } from './types'

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn<() => string>() }))
vi.mock('electron', () => ({ app: { getPath } }))
vi.mock('../usage/usage-scan-worker-spawn', () => ({ scanClaudeUsageFilesViaWorker: vi.fn() }))

import { ClaudeUsageStore, initClaudeUsagePath } from './store'
import { scanClaudeUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'

let directory: string
let transcript: string
const KEY_COUNT = 1024
const backingStore = { getRepos: () => [], getAllWorktreeMeta: () => ({}) }

function assistantRow(index: number, duplicate = false): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: duplicate ? 'later-session' : 'original-session',
    timestamp: duplicate ? '2026-10-10T12:00:00.000Z' : '2026-10-09T12:00:00.000Z',
    cwd: duplicate ? join(directory, 'later-location') : directory,
    requestId: `request-${index}`,
    message: {
      id: `message-${index}`,
      model: duplicate ? 'later-model' : 'claude-sonnet-4-6',
      usage: {
        input_tokens: duplicate ? 2000 : 1000 + index,
        output_tokens: duplicate ? 55 : 10 + (index % 7),
        cache_read_input_tokens: duplicate ? 5 : index % 11,
        cache_creation_input_tokens: duplicate ? 15 : 10 + (index % 17),
        cache_creation: { ephemeral_1h_input_tokens: duplicate ? 3 : index % 3 }
      }
    }
  })}\n`
}

async function project(previous?: ClaudeUsagePersistedFile): Promise<ClaudeUsagePersistedFile> {
  const read = await readClaudeUsageScanFile(transcript, previous?.parseResumeState)
  return projectClaudeUsageScanFile(read, new Map(), () => true, previous)
}

function persistedState(files: ClaudeUsagePersistedFile[]): ClaudeUsagePersistedState {
  return {
    schemaVersion: 6,
    worktreeFingerprint: '[]',
    processedFiles: files,
    sessions: structuredClone(files.flatMap((file) => file.sessions)),
    dailyAggregates: structuredClone(files.flatMap((file) => file.dailyAggregates)),
    scanState: {
      enabled: true,
      lastScanStartedAt: Date.now(),
      lastScanCompletedAt: Date.now(),
      lastScanError: null
    }
  }
}

async function writeResumableFixture(): Promise<ClaudeUsagePersistedFile> {
  await writeFile(
    transcript,
    `${JSON.stringify({ type: 'user', text: 'x'.repeat(20_000) })}\n${assistantRow(0)}`
  )
  return project()
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-checkpoint-persistence-'))
  transcript = join(directory, 'session.jsonl')
  getPath.mockReturnValue(directory)
  initClaudeUsagePath()
  vi.mocked(scanClaudeUsageFilesViaWorker).mockReset()
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('persists every distinct maximum within the cache byte budget and resumes an older indented cache', async () => {
  await writeFile(
    transcript,
    Array.from({ length: KEY_COUNT }, (_, index) => assistantRow(index)).join('')
  )
  const initial = await project()
  vi.mocked(scanClaudeUsageFilesViaWorker).mockResolvedValue({
    processedFiles: [initial],
    sessions: initial.sessions,
    dailyAggregates: initial.dailyAggregates
  })
  const store = new ClaudeUsageStore(backingStore)
  await store.setEnabled(true)
  await store.refresh(true)
  await store.flush()

  const cachePath = join(directory, 'orca-claude-usage.json')
  const persisted = await readFile(cachePath, 'utf8')
  const parsed = JSON.parse(persisted)
  expect(Buffer.byteLength(persisted)).toBeLessThan(100_000)
  expect(parsed).toMatchObject({
    processedFiles: [initial],
    sessions: initial.sessions,
    dailyAggregates: initial.dailyAggregates,
    scanState: { enabled: true, lastScanError: null }
  })
  expect(initial.ownedDedupeKeys).toHaveLength(KEY_COUNT)
  expect(initial.parseResumeState?.ownedTokenMaxima).toHaveLength(KEY_COUNT)

  await writeFile(cachePath, JSON.stringify(parsed, null, 2))
  await appendFile(transcript, assistantRow(0, true))
  vi.mocked(scanClaudeUsageFilesViaWorker).mockImplementationOnce(
    async (_worktrees, previous = []) => {
      expect(previous).toEqual([initial])
      const extended = await project(previous[0])
      return {
        processedFiles: [extended],
        sessions: extended.sessions,
        dailyAggregates: extended.dailyAggregates
      }
    }
  )
  const restarted = new ClaudeUsageStore(backingStore)
  await restarted.refresh(true)
  await restarted.flush()

  const afterRestart = JSON.parse(await readFile(cachePath, 'utf8'))
  const cold = await project()
  expect(afterRestart).toMatchObject({
    processedFiles: [cold],
    sessions: cold.sessions,
    dailyAggregates: cold.dailyAggregates,
    scanState: { enabled: true, lastScanError: null }
  })
  expect(cold.ownedDedupeKeys).toHaveLength(KEY_COUNT)
  expect(cold.sessions[0]?.sessionId).toBe('original-session')
  expect(cold.sessions[0]?.turnCount).toBe(KEY_COUNT)
  expect(cold.parseResumeState?.ownedTokenMaxima[0]).toEqual([2000, 55, 5, 15, 3, 0])
})

it('hides invalid saved totals until a refresh rebuilds the owner and its deferred fork', async () => {
  const initial = await writeResumableFixture()
  const forkPath = join(directory, 'fork.jsonl')
  await writeFile(forkPath, await readFile(transcript, 'utf8'))
  const fork = await projectClaudeUsageScanFile(
    await readClaudeUsageScanFile(forkPath),
    new Map(),
    () => false
  )
  expect(fork.hasDeferredClaims).toBe(true)
  const state = persistedState([initial, fork])
  const maxima = initial.parseResumeState?.ownedTokenMaxima[0]
  if (!maxima) {
    throw new Error('Expected a resumable owner fixture.')
  }
  maxima[0]--
  await writeFile(join(directory, 'orca-claude-usage.json'), JSON.stringify(state))

  const store = new ClaudeUsageStore(backingStore)
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
  vi.mocked(scanClaudeUsageFilesViaWorker).mockImplementationOnce(
    async (_worktrees, previous = []) => {
      expect(previous).toEqual([])
      const cold = await project()
      return {
        processedFiles: [cold],
        sessions: cold.sessions,
        dailyAggregates: cold.dailyAggregates
      }
    }
  )
  await store.refresh(false)
  await store.flush()
  expect(store.getSnapshot('all', 'all')).toMatchObject({
    summary: { sessions: 1, turns: 1, inputTokens: 1000 },
    scanState: { enabled: true, hasAnyClaudeData: true, lastScanError: null }
  })
})

it('reconstructs duplicated global totals from validated file projections on load', async () => {
  const initial = await writeResumableFixture()
  const state = persistedState([initial])
  const session = state.sessions[0]
  const daily = state.dailyAggregates[0]
  if (!session || !daily) {
    throw new Error('Expected saved global totals.')
  }
  session.totalInputTokens++
  daily.inputTokens++
  await writeFile(join(directory, 'orca-claude-usage.json'), JSON.stringify(state))

  const store = new ClaudeUsageStore(backingStore)
  expect(store.getSnapshot('all', 'all')).toMatchObject({
    summary: { sessions: 1, turns: 1, inputTokens: 1000 },
    daily: [{ inputTokens: 1000 }],
    scanState: { enabled: true, lastScanCompletedAt: state.scanState.lastScanCompletedAt }
  })
  await store.refresh(false)
  expect(scanClaudeUsageFilesViaWorker).not.toHaveBeenCalled()
})

it('retains both signed and older aggregate-only file totals when loading a fresh cache', async () => {
  const initial = await writeResumableFixture()
  const legacyPath = join(directory, 'legacy.jsonl')
  await writeFile(legacyPath, assistantRow(1))
  const legacy = await projectClaudeUsageScanFile(
    await readClaudeUsageScanFile(legacyPath),
    new Map(),
    () => true
  )
  delete legacy.parseResumeState
  const state = persistedState([initial, legacy])
  await writeFile(join(directory, 'orca-claude-usage.json'), JSON.stringify(state))

  const store = new ClaudeUsageStore(backingStore)
  expect(store.getSnapshot('all', 'all')).toMatchObject({
    summary: { sessions: 1, turns: 2, inputTokens: 2001 },
    daily: [{ inputTokens: 2001 }],
    scanState: { enabled: true, lastScanCompletedAt: state.scanState.lastScanCompletedAt }
  })
  await store.refresh(false)
  expect(scanClaudeUsageFilesViaWorker).not.toHaveBeenCalled()
})

it.each(['nonArray', 'nullEntry', 'unsignedRollup'] as const)(
  'preserves tracking when malformed %s cache records cannot be validated',
  async (malformation) => {
    const initial = await writeResumableFixture()
    const state = persistedState([initial])
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
      join(directory, 'orca-claude-usage.json'),
      JSON.stringify({ ...state, processedFiles: malformedFiles })
    )

    const store = new ClaudeUsageStore(backingStore)
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
