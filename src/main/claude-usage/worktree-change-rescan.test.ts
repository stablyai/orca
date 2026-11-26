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

const turn = (sessionId: string, id: number, inputTokens: number) =>
  `${JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: '2026-10-09T12:00:00.000Z',
    cwd: join(directory, 'wt'),
    requestId: `request-${id}`,
    message: {
      id: `message-${id}`,
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: inputTokens }
    }
  })}\n`

class WorkerStopped extends Error {}

// Fork `b` copies owner `a`'s turn; `a` owns it and `b` defers it until `a` disappears.
async function forkedHistory() {
  const owner = join(directory, 'a-owner.jsonl')
  const other = join(directory, 'c-other.jsonl')
  await writeFile(owner, turn('original', 1, 100))
  await writeFile(join(directory, 'b-fork.jsonl'), turn('fork', 1, 100))
  await writeFile(other, turn('other', 2, 50))
  const files = [owner, join(directory, 'b-fork.jsonl'), other]
  vi.mocked(listClaudeTranscriptFiles).mockImplementation(async () => [...files])
  const worktree = { worktreeId: 'repo::wt', path: join(directory, 'wt'), displayName: 'wt' }
  const scan = async (displayName: string, stopAtCheckpoint = false) => {
    const rows = [{ ...worktree, displayName }]
    const ref = {
      path: join(directory, 'sources.json'),
      schemaVersion: 7,
      worktreeFingerprint: getUsageWorktreeFingerprint(new Map([['repo', rows]]))
    }
    const previous = await readClaudeUsageSourceCache(ref)
    try {
      const result = await scanClaudeUsageFiles(
        rows.map((row) => ({ repoId: 'repo', ...row })),
        previous.sources,
        undefined,
        [],
        previous.verifiedSources,
        async (checkpoint) => {
          await writeClaudeUsageSourceCache(ref, checkpoint)
          if (stopAtCheckpoint) {
            throw new WorkerStopped()
          }
        }
      )
      await writeClaudeUsageSourceCache(ref, result.processedFiles)
      return result.dailyAggregates.map((day) => [day.projectLabel, day.inputTokens])
    } catch (error) {
      if (error instanceof WorkerStopped) {
        return null
      }
      throw error
    }
  }
  const deleteOwner = async () => {
    await unlink(owner)
    files.splice(0, 1)
  }
  return { scan, deleteOwner, other }
}

it('reclaims a fork copy when its owner is deleted while the worktree is renamed', async () => {
  const history = await forkedHistory()
  expect(await history.scan('wt')).toEqual([['wt', 150]])
  await history.deleteOwner()
  expect(await history.scan('renamed')).toEqual([['renamed', 150]])
})

it('never checkpoints away a pending reclaim, so a quit mid-scan loses no usage', async () => {
  const history = await forkedHistory()
  expect(await history.scan('wt')).toEqual([['wt', 150]])
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000))
  await history.deleteOwner()
  await writeFile(history.other, turn('other', 2, 50) + turn('other', 3, 25))
  await history.scan('wt', true)
  expect(await history.scan('wt')).toEqual([['wt', 175]])
})
