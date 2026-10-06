import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'
import type * as RelayScan from './claude-usage-relay-scan'

const tempRoots: string[] = []

function assistantLine(sessionId: string, inputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: '2026-09-20T10:00:00.000Z',
    cwd: '/home/dev/repo/packages/app',
    message: {
      id: `msg-${sessionId}-${inputTokens}`,
      model: 'claude-opus-5',
      usage: { input_tokens: inputTokens, output_tokens: 1 }
    }
  })
}

async function loadRelayScan(): Promise<{
  root: string
  transcript: string
  cacheFile: string
  module: typeof RelayScan
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-claude-usage-'))
  tempRoots.push(root)
  const projectDir = join(root, '.claude', 'projects', 'repo')
  await mkdir(projectDir, { recursive: true })
  const transcript = join(projectDir, 'session.jsonl')
  await writeFile(transcript, assistantLine('session-1', 100))
  vi.resetModules()
  vi.doMock('os', async () => ({
    ...(await vi.importActual<typeof Os>('os')),
    homedir: () => root
  }))
  const module = await import('./claude-usage-relay-scan')
  return { root, transcript, cacheFile: module.relayClaudeUsageCacheFile(root), module }
}

const worktrees = [
  {
    repoId: 'repo',
    worktreeId: 'repo::/home/dev/repo',
    path: '/home/dev/repo',
    displayName: 'Repo'
  }
]

afterEach(async () => {
  vi.doUnmock('os')
  vi.resetModules()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('scanRelayClaudeUsage', () => {
  it('returns attributed aggregates and keeps the per-file cache on the host', async () => {
    const { cacheFile, module } = await loadRelayScan()

    const result = await module.scanRelayClaudeUsage({ worktrees }, cacheFile)

    expect(result.pageIndex).toBe(0)
    expect(result.pageCount).toBe(1)
    expect(result.sessions.map((row) => [row.sessionId, row.primaryWorktreeId])).toEqual([
      ['session-1', 'repo::/home/dev/repo']
    ])
    expect(result.dailyAggregates.map((row) => [row.projectKey, row.inputTokens])).toEqual([
      ['worktree:repo::/home/dev/repo', 100]
    ])
    expect(result).not.toHaveProperty('processedFiles')
    const cache = JSON.parse(await readFile(cacheFile, 'utf-8'))
    expect(cache.processedFiles).toHaveLength(1)
  })

  it('reuses the on-disk cache after the sidecar restarts', async () => {
    const { transcript, cacheFile, module } = await loadRelayScan()
    const fixedTime = new Date('2026-09-20T12:00:00.000Z')
    await utimes(transcript, fixedTime, fixedTime)
    await module.scanRelayClaudeUsage({ worktrees }, cacheFile)
    // Same size and mtime: only a reused cache can still report 100 tokens.
    await writeFile(transcript, assistantLine('session-1', 900))
    await utimes(transcript, fixedTime, fixedTime)
    module.resetRelayClaudeUsageCacheForTests()

    const reused = await module.scanRelayClaudeUsage({ worktrees }, cacheFile)
    const reattributed = await module.scanRelayClaudeUsage({ worktrees: [] }, cacheFile)

    expect(reused.dailyAggregates[0].inputTokens).toBe(100)
    // A different worktree set invalidates attribution, so the file is reparsed.
    expect(reattributed.dailyAggregates[0].inputTokens).toBe(900)
  })

  it('serves later pages from the same scan and rejects a stale scan id', async () => {
    const { transcript, cacheFile, module } = await loadRelayScan()
    await writeFile(
      transcript,
      Array.from({ length: 301 }, (_, index) => assistantLine(`session-${index}`, 1)).join('\n')
    )

    const first = await module.scanRelayClaudeUsage({ worktrees }, cacheFile)
    const second = await module.scanRelayClaudeUsage(
      { worktrees, page: { scanId: first.scanId, index: 1 } },
      cacheFile
    )

    expect([first.pageCount, first.sessions.length, second.sessions.length]).toEqual([2, 300, 1])
    expect(second.scanId).toBe(first.scanId)
    await expect(
      module.scanRelayClaudeUsage({ worktrees, page: { scanId: 'other', index: 1 } }, cacheFile)
    ).rejects.toThrow('rescan required')
  })

  it('stops a running scan on cancel and keeps the previous result servable', async () => {
    const { root, cacheFile, module } = await loadRelayScan()
    const first = await module.scanRelayClaudeUsage({ worktrees }, cacheFile)
    const cacheBefore = await readFile(cacheFile, 'utf-8')
    // More files than one scan batch, so the scan reaches a cancellation point mid-way.
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeFile(
          join(root, '.claude', 'projects', 'repo', `extra-${index}.jsonl`),
          assistantLine(`extra-${index}`, 1)
        )
      )
    )
    const controller = new AbortController()

    const cancelled = module.scanRelayClaudeUsage({ worktrees }, cacheFile, controller.signal)
    controller.abort()

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readFile(cacheFile, 'utf-8')).toBe(cacheBefore)
    await expect(
      module.scanRelayClaudeUsage(
        { worktrees, page: { scanId: first.scanId, index: 1 } },
        cacheFile
      )
    ).resolves.toMatchObject({ scanId: first.scanId, sessions: [] })
  })
})
