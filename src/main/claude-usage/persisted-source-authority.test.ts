import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeUsagePersistedFile, ClaudeUsagePersistedState } from './types'
import { scanClaudeUsageFiles } from './scanner'
import { readClaudeUsageScanFile } from './transcript-record-parser'
import { projectClaudeUsageScanFile } from './transcript-usage-projection'
import { parseClaudeUsageReport } from './persisted-usage-report'
import { splitClaudeUsageCacheFile } from './persisted-source-cache'

const { discovered } = vi.hoisted(() => {
  const discovered: { paths: string[] } = { paths: [] }
  return { discovered }
})
vi.mock('./transcript-file-discovery', () => ({
  listClaudeTranscriptFiles: async () => discovered.paths
}))

let directory: string
let transcript: string

function row(input: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'authority',
    requestId: 'request',
    timestamp: '2026-10-09T12:00:00.000Z',
    message: { id: 'message', usage: { input_tokens: input, output_tokens: 2 } }
  })}\n`
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
  discovered.paths = [transcript]
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
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
