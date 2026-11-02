import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import type { ClaudeUsagePersistedFile, ClaudeUsagePersistedState } from './types'
import { readClaudeUsageScanFile } from './transcript-record-parser'
import { projectClaudeUsageScanFile } from './transcript-usage-projection'
import { scanClaudeUsageFiles } from './scanner'
import {
  readClaudeUsageSourceCache,
  splitClaudeUsageCacheFile,
  persistClaudeUsageSourceCache
} from './persisted-source-cache'
import { normalizeClaudeUsageSourceFiles } from './persisted-projection-validation'
import { usageSourceCachePath } from '../usage/usage-source-cache-file'

import { ClaudeUsageStore, initClaudeUsagePath } from './store'
import { listClaudeTranscriptFiles } from './transcript-file-discovery'
import {
  scanClaudeUsageFilesViaWorker,
  splitUsageCacheFileViaWorker
} from '../usage/usage-scan-worker-spawn'

export async function createPersistedUsageTestFixture(getPath: Mock<() => string>) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-claude-persisted-usage-'))
  const transcript = join(directory, 'session.jsonl')
  const reportPath = join(directory, 'orca-claude-usage.json')
  const sourceRef = {
    path: usageSourceCachePath(reportPath),
    schemaVersion: 7,
    worktreeFingerprint: '[]',
    reuse: true
  }
  const transcripts = [transcript]
  getPath.mockReturnValue(directory)
  initClaudeUsagePath()
  vi.mocked(listClaudeTranscriptFiles).mockReset()
  vi.mocked(listClaudeTranscriptFiles).mockImplementation(async () => [...transcripts].sort())
  vi.mocked(splitUsageCacheFileViaWorker).mockReset()
  vi.mocked(splitUsageCacheFileViaWorker).mockImplementation(splitClaudeUsageCacheFile)
  vi.mocked(scanClaudeUsageFilesViaWorker).mockReset()
  vi.mocked(scanClaudeUsageFilesViaWorker).mockImplementation(async (worktrees, ref) => {
    const previous = await readClaudeUsageSourceCache(ref)
    const result = await scanClaudeUsageFiles(
      worktrees,
      previous.sources,
      undefined,
      [],
      previous.verifiedSources
    )
    await persistClaudeUsageSourceCache(ref, result.processedFiles, previous)
    return { sessions: result.sessions, dailyAggregates: result.dailyAggregates }
  })

  function row(index: number, duplicate = false): string {
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
    return projectClaudeUsageScanFile(
      await readClaudeUsageScanFile(transcript, previous?.parseResumeState),
      new Map(),
      () => true,
      previous
    )
  }

  function state(files: ClaudeUsagePersistedFile[], schemaVersion = 6): ClaudeUsagePersistedState {
    return {
      schemaVersion,
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

  async function writeResumable(): Promise<ClaudeUsagePersistedFile> {
    await writeFile(
      transcript,
      `${JSON.stringify({ type: 'user', text: 'x'.repeat(20_000) })}\n${row(0)}`
    )
    return project()
  }

  return {
    scanWorker: vi.mocked(scanClaudeUsageFilesViaWorker),
    splitWorker: vi.mocked(splitUsageCacheFileViaWorker),
    directory,
    transcript,
    transcripts,
    reportPath,
    sourceRef,
    row,
    project,
    state,
    writeResumable,
    createStore: () => new ClaudeUsageStore({ getRepos: () => [], getAllWorktreeMeta: () => ({}) }),
    decodedSources: async () => {
      const read = await readClaudeUsageSourceCache(sourceRef)
      return normalizeClaudeUsageSourceFiles(read.sources, read.verifiedSources).processedFiles
    },
    cleanup: async () => {
      vi.restoreAllMocks()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

export type PersistedUsageTestFixture = Awaited<ReturnType<typeof createPersistedUsageTestFixture>>
