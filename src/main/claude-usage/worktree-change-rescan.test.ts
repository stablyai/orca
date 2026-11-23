import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { scanClaudeUsageFiles } from './scanner'
import { readClaudeUsageSourceCache, writeClaudeUsageSourceCache } from './persisted-source-cache'
import { listClaudeTranscriptFiles } from './transcript-file-discovery'
import { getUsageWorktreeFingerprint } from '../usage/worktree-attribution/usage-worktree-refs'

vi.mock('./transcript-file-discovery', () => ({ listClaudeTranscriptFiles: vi.fn() }))

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-worktree-change-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

it('reclaims a fork copy when its owner is deleted while the worktree is renamed', async () => {
  const owner = join(directory, 'a-owner.jsonl')
  const fork = join(directory, 'b-fork.jsonl')
  const turn = (sessionId: string) =>
    `${JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp: '2026-10-09T12:00:00.000Z',
      cwd: join(directory, 'wt'),
      requestId: 'request-1',
      message: { id: 'message-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 100 } }
    })}\n`
  await writeFile(owner, turn('original'))
  await writeFile(fork, turn('fork'))
  const files = [owner, fork]
  vi.mocked(listClaudeTranscriptFiles).mockImplementation(async () => [...files])
  const worktree = { worktreeId: 'repo::wt', path: join(directory, 'wt'), displayName: 'wt' }
  const scan = async (displayName: string) => {
    const rows = [{ ...worktree, displayName }]
    const ref = {
      path: join(directory, 'sources.json'),
      schemaVersion: 7,
      worktreeFingerprint: getUsageWorktreeFingerprint(new Map([['repo', rows]]))
    }
    const previous = await readClaudeUsageSourceCache(ref)
    const result = await scanClaudeUsageFiles(
      rows.map((row) => ({ repoId: 'repo', ...row })),
      previous.sources,
      undefined,
      [],
      previous.verifiedSources
    )
    await writeClaudeUsageSourceCache(ref, result.processedFiles)
    return result.dailyAggregates.map((day) => [day.projectLabel, day.inputTokens])
  }

  expect(await scan('wt')).toEqual([['wt', 100]])
  await unlink(owner)
  files.splice(0, 1)
  expect(await scan('renamed')).toEqual([['renamed', 100]])
})
