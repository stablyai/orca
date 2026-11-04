import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import type * as TranscriptRecordParser from './transcript-record-parser'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: homedirMock
}))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  claudeProfileHistoryDirs: () => []
}))
vi.mock('./transcript-record-parser', async () => {
  const actual = await vi.importActual<typeof TranscriptRecordParser>('./transcript-record-parser')
  return { ...actual, readClaudeUsageScanFile: vi.fn(actual.readClaudeUsageScanFile) }
})

let root: string
let projectDir: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-fork-corrections-'))
  homedirMock.mockReturnValue(root)
  projectDir = join(root, '.claude', 'projects', 'project-a')
  await mkdir(projectDir, { recursive: true })
  vi.resetModules()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function assistantRow(outputTokens: number, cacheReadTokens = 0, id = 'shared'): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'owner-session',
    timestamp: '2026-10-09T12:00:00.000Z',
    message: {
      id,
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 10,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadTokens
      }
    }
  })}\n`
}

it.each([
  { size: 'small', mutation: 'delete' },
  { size: 'small', mutation: 'rewrite' },
  { size: 'resumable', mutation: 'delete' },
  { size: 'resumable', mutation: 'rewrite' }
])('rebuilds $size owner corrections after a fork $mutation', async ({ size, mutation }) => {
  const { scanClaudeUsageFiles: scan } = await import('./scanner')
  const { readClaudeUsageScanFile } = await import('./transcript-record-parser')
  const ownerPath = join(projectDir, 'aaaa-owner.jsonl')
  const forkPath = join(projectDir, 'zzzz-fork.jsonl')
  const remainingPath = join(projectDir, 'yyyy-remaining.jsonl')
  const prefix =
    size === 'resumable'
      ? `${JSON.stringify({ type: 'user', content: '界'.repeat(12_000) })}\n`
      : ''
  await writeFile(ownerPath, prefix + assistantRow(10))
  await writeFile(remainingPath, prefix + assistantRow(20, 5))
  await writeFile(forkPath, prefix + assistantRow(3_080, 200_000))
  const first = await scan([], [], undefined, [])
  const snapshot = structuredClone(first)
  expect(first.sessions[0]).toMatchObject({ totalOutputTokens: 3_080 })
  await (mutation === 'delete' ? rm(forkPath) : writeFile(forkPath, prefix + assistantRow(30)))
  const updated = await scan([], first.processedFiles, undefined, [])
  const cold = await scan([], [], undefined, [])
  expect(updated.sessions).toEqual(cold.sessions)
  expect(updated.dailyAggregates).toEqual(cold.dailyAggregates)
  expect(updated.sessions[0]).toMatchObject({
    turnCount: 1,
    totalOutputTokens: mutation === 'delete' ? 20 : 30,
    totalCacheReadTokens: 5
  })
  expect(first).toEqual(snapshot)
  vi.mocked(readClaudeUsageScanFile).mockClear()
  const noop = await scan([], updated.processedFiles, undefined, [])
  expect(readClaudeUsageScanFile).not.toHaveBeenCalled()
  expect(noop.sessions).toEqual(cold.sessions)
  expect(noop.dailyAggregates).toEqual(cold.dailyAggregates)
})

it.each(['small', 'resumable'])(
  'replays unchanged mixed-owner forks after an uncorrected %s owner decreases',
  async (size) => {
    const { scanClaudeUsageFiles: scan } = await import('./scanner')
    const { readClaudeUsageScanFile } = await import('./transcript-record-parser')
    const ownerPath = join(projectDir, 'aaaa-owner.jsonl')
    const forkPath = join(projectDir, 'zzzz-fork.jsonl')
    const prefix =
      size === 'resumable'
        ? `${JSON.stringify({ type: 'user', content: '界'.repeat(12_000) })}\n`
        : ''
    await writeFile(ownerPath, prefix + assistantRow(100, 200_000))
    await writeFile(forkPath, prefix + assistantRow(80, 100) + assistantRow(5, 0, 'fork-only'))
    const first = await scan([], [], undefined, [])
    const snapshot = structuredClone(first)
    expect(first.processedFiles[0].hasCrossFileCorrections).toBe(false)
    expect(first.sessions[0]).toMatchObject({ turnCount: 2, totalOutputTokens: 105 })

    await writeFile(ownerPath, prefix + assistantRow(10))
    const updated = await scan([], first.processedFiles, undefined, [])
    const cold = await scan([], [], undefined, [])
    expect(updated.sessions).toEqual(cold.sessions)
    expect(updated.dailyAggregates).toEqual(cold.dailyAggregates)
    expect(updated.sessions[0]).toMatchObject({
      turnCount: 2,
      totalOutputTokens: 85,
      totalCacheReadTokens: 100
    })
    expect(first).toEqual(snapshot)

    vi.mocked(readClaudeUsageScanFile).mockClear()
    const noop = await scan([], updated.processedFiles, undefined, [])
    expect(readClaudeUsageScanFile).not.toHaveBeenCalled()
    expect(noop.sessions).toEqual(cold.sessions)
    const restarted = await scan(
      [],
      JSON.parse(JSON.stringify(updated.processedFiles)),
      undefined,
      []
    )
    expect(restarted.sessions).toEqual(cold.sessions)
    expect(restarted.dailyAggregates).toEqual(cold.dailyAggregates)
  }
)
