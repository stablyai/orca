import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'
import type * as FsPromises from 'node:fs/promises'

const tempRoots: string[] = []

async function makeClaudeProjectsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-usage-'))
  tempRoots.push(root)
  await mkdir(join(root, '.claude', 'projects', 'project-a'), { recursive: true })
  await mkdir(join(root, '.claude', 'transcripts'), { recursive: true })
  return root
}

afterEach(async () => {
  vi.doUnmock('os')
  vi.doUnmock('fs/promises')
  vi.resetModules()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('scanClaudeUsageFiles', () => {
  it('scans transcript files from the configured Claude projects directory', async () => {
    const root = await makeClaudeProjectsRoot()
    const projectDir = join(root, '.claude', 'projects', 'project-a')
    const transcriptsDir = join(root, '.claude', 'transcripts')
    const firstFile = join(projectDir, 'a.jsonl')
    const secondFile = join(projectDir, 'b.jsonl')
    const transcriptFile = join(transcriptsDir, 'ses_123.jsonl')

    await writeFile(
      firstFile,
      [
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          timestamp: '2026-04-09T10:00:00.000Z',
          cwd: '/workspace/repo-a',
          message: {
            model: 'claude-sonnet-4-6',
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5
            }
          }
        }),
        JSON.stringify({ type: 'user', sessionId: 'session-1' })
      ].join('\n')
    )
    await writeFile(
      secondFile,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-2',
        timestamp: '2026-04-10T10:00:00.000Z',
        cwd: '/outside/repo-b',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 50,
            output_tokens: 10
          }
        }
      })
    )
    await writeFile(
      transcriptFile,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-11T10:00:00.000Z',
        cwd: '/workspace/repo-a/packages/app',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 70,
            output_tokens: 15,
            cache_read_input_tokens: 20
          }
        }
      })
    )

    vi.resetModules()
    vi.doMock('os', async () => ({
      ...(await vi.importActual<typeof Os>('os')),
      homedir: () => root
    }))
    const { scanClaudeUsageFiles } = await import('./scanner')

    const result = await scanClaudeUsageFiles([
      {
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        path: '/workspace/repo-a',
        displayName: 'Repo A'
      }
    ])

    expect(result.processedFiles.map((file) => [file.path, file.lineCount])).toEqual([
      [firstFile, 2],
      [secondFile, 1],
      [transcriptFile, 1]
    ])
    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      'ses_123',
      'session-2',
      'session-1'
    ])
    expect(result.dailyAggregates).toHaveLength(3)
    expect(result.dailyAggregates[0]?.projectLabel).toBe('Repo A')
    expect(result.dailyAggregates[2]?.projectLabel).toBe('Repo A')
  })

  it('reuses unchanged transcript projections from the previous scan', async () => {
    const root = await makeClaudeProjectsRoot()
    const projectDir = join(root, '.claude', 'projects', 'project-a')
    const transcriptFile = join(projectDir, 'session-1.jsonl')

    await writeFile(
      transcriptFile,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-1',
        timestamp: '2026-04-09T10:00:00.000Z',
        cwd: '/workspace/repo-a',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 100,
            output_tokens: 20
          }
        }
      })
    )

    vi.resetModules()
    vi.doMock('os', async () => ({
      ...(await vi.importActual<typeof Os>('os')),
      homedir: () => root
    }))
    const { scanClaudeUsageFiles } = await import('./scanner')
    const worktrees = [
      {
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        path: '/workspace/repo-a',
        displayName: 'Repo A'
      }
    ]

    const first = await scanClaudeUsageFiles(worktrees)
    const cachedFile = structuredClone(first.processedFiles[0]!)
    cachedFile.sessions[0]!.totalInputTokens = 999
    cachedFile.sessions[0]!.locationBreakdown[0]!.inputTokens = 999
    cachedFile.dailyAggregates[0]!.inputTokens = 999

    const second = await scanClaudeUsageFiles(worktrees, [cachedFile])

    expect(second.processedFiles[0]?.sessions[0]?.totalInputTokens).toBe(999)
    expect(second.dailyAggregates[0]?.inputTokens).toBe(999)
  })

  it('dedupes fork copies when only message.id is present (no requestId)', async () => {
    const root = await makeClaudeProjectsRoot()
    const projectDir = join(root, '.claude', 'projects', 'project-a')
    const originalFile = join(projectDir, 'aaaa-original.jsonl')
    const forkFile = join(projectDir, 'bbbb-fork.jsonl')

    const turn = (sessionId: string, messageId: string, inputTokens: number): string =>
      JSON.stringify({
        type: 'assistant',
        sessionId,
        timestamp: '2026-04-09T10:00:00.000Z',
        cwd: '/workspace/repo-a',
        message: {
          id: messageId,
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: inputTokens, output_tokens: 10 }
        }
      })

    await writeFile(originalFile, turn('session-1', 'msg_1', 100))
    await writeFile(
      forkFile,
      [turn('session-2', 'msg_1', 100), turn('session-2', 'msg_2', 50)].join('\n')
    )

    vi.resetModules()
    vi.doMock('os', async () => ({
      ...(await vi.importActual<typeof Os>('os')),
      homedir: () => root
    }))
    const { scanClaudeUsageFiles } = await import('./scanner')

    const result = await scanClaudeUsageFiles([])
    expect(result.dailyAggregates.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(150)
    expect(result.processedFiles[0]?.ownedDedupeKeys).toEqual(['msg:msg_1'])
    expect(result.processedFiles[1]?.ownedDedupeKeys).toEqual(['msg:msg_2'])
  })

  it('dedupes fork copies via uuid when message ids are absent', async () => {
    const root = await makeClaudeProjectsRoot()
    const projectDir = join(root, '.claude', 'projects', 'project-a')
    const originalFile = join(projectDir, 'aaaa-original.jsonl')
    const forkFile = join(projectDir, 'bbbb-fork.jsonl')

    const turn = (sessionId: string, uuid: string, inputTokens: number): string =>
      JSON.stringify({
        type: 'assistant',
        sessionId,
        uuid,
        timestamp: '2026-04-09T10:00:00.000Z',
        cwd: '/workspace/repo-a',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: inputTokens, output_tokens: 10 }
        }
      })

    await writeFile(originalFile, turn('session-1', 'uuid-1', 100))
    await writeFile(
      forkFile,
      [turn('session-2', 'uuid-1', 100), turn('session-2', 'uuid-2', 40)].join('\n')
    )

    vi.resetModules()
    vi.doMock('os', async () => ({
      ...(await vi.importActual<typeof Os>('os')),
      homedir: () => root
    }))
    const { scanClaudeUsageFiles } = await import('./scanner')

    const result = await scanClaudeUsageFiles([])
    expect(result.dailyAggregates.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(140)
    expect(result.processedFiles[0]?.ownedDedupeKeys).toEqual(['uuid:uuid-1'])
    expect(result.processedFiles[1]?.ownedDedupeKeys).toEqual(['uuid:uuid-2'])
  })

  it('counts turns copied into forked session files exactly once', async () => {
    const root = await makeClaudeProjectsRoot()
    const projectDir = join(root, '.claude', 'projects', 'project-a')
    const originalFile = join(projectDir, 'aaaa-original.jsonl')
    const forkFile = join(projectDir, 'bbbb-fork.jsonl')

    const turn = (
      sessionId: string,
      messageId: string,
      requestId: string,
      inputTokens: number
    ): string =>
      JSON.stringify({
        type: 'assistant',
        sessionId,
        timestamp: '2026-04-09T10:00:00.000Z',
        requestId,
        cwd: '/workspace/repo-a',
        message: {
          id: messageId,
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: inputTokens, output_tokens: 10 }
        }
      })

    await writeFile(
      originalFile,
      [turn('session-1', 'msg_1', 'req_1', 100), turn('session-1', 'msg_2', 'req_2', 200)].join(
        '\n'
      )
    )
    // Fork copies the original history with preserved message/request IDs but a
    // rewritten sessionId, then appends its own new turn.
    await writeFile(
      forkFile,
      [
        turn('session-2', 'msg_1', 'req_1', 100),
        turn('session-2', 'msg_2', 'req_2', 200),
        turn('session-2', 'msg_3', 'req_3', 400)
      ].join('\n')
    )

    vi.resetModules()
    vi.doMock('os', async () => ({
      ...(await vi.importActual<typeof Os>('os')),
      homedir: () => root
    }))
    const { scanClaudeUsageFiles } = await import('./scanner')

    const result = await scanClaudeUsageFiles([])
    const totalInput = result.dailyAggregates.reduce(
      (sum, aggregate) => sum + aggregate.inputTokens,
      0
    )

    expect(totalInput).toBe(700)
    expect(result.processedFiles[0]?.ownedDedupeKeys).toEqual(['msg_1:req_1', 'msg_2:req_2'])
    expect(result.processedFiles[0]?.hasDeferredClaims).toBe(false)
    expect(result.processedFiles[1]?.ownedDedupeKeys).toEqual(['msg_3:req_3'])
    expect(result.processedFiles[1]?.hasDeferredClaims).toBe(true)
  })

  it('keeps fork dedupe stable when the original file projection is reused from cache', async () => {
    const root = await makeClaudeProjectsRoot()
    const projectDir = join(root, '.claude', 'projects', 'project-a')
    const originalFile = join(projectDir, 'aaaa-original.jsonl')
    const forkFile = join(projectDir, 'zzzz-fork.jsonl')

    const turn = (
      sessionId: string,
      messageId: string,
      requestId: string,
      inputTokens: number
    ): string =>
      JSON.stringify({
        type: 'assistant',
        sessionId,
        timestamp: '2026-04-09T10:00:00.000Z',
        requestId,
        cwd: '/workspace/repo-a',
        message: {
          id: messageId,
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: inputTokens, output_tokens: 10 }
        }
      })

    await writeFile(originalFile, turn('session-1', 'msg_1', 'req_1', 100))

    vi.resetModules()
    vi.doMock('os', async () => ({
      ...(await vi.importActual<typeof Os>('os')),
      homedir: () => root
    }))
    const { scanClaudeUsageFiles } = await import('./scanner')

    const first = await scanClaudeUsageFiles([])
    expect(first.processedFiles[0]?.ownedDedupeKeys).toEqual(['msg_1:req_1'])

    // A fork appears later while the original stays unchanged (cache reuse).
    await writeFile(
      forkFile,
      [turn('session-2', 'msg_1', 'req_1', 100), turn('session-2', 'msg_9', 'req_9', 50)].join('\n')
    )

    const second = await scanClaudeUsageFiles([], first.processedFiles)
    const totalInput = second.dailyAggregates.reduce(
      (sum, aggregate) => sum + aggregate.inputTokens,
      0
    )

    expect(totalInput).toBe(150)
    expect(second.processedFiles.map((file) => file.ownedDedupeKeys)).toEqual([
      ['msg_1:req_1'],
      ['msg_9:req_9']
    ])

    // Rescanning with the full cache stays stable.
    const third = await scanClaudeUsageFiles([], second.processedFiles)
    expect(third.dailyAggregates.reduce((sum, aggregate) => sum + aggregate.inputTokens, 0)).toBe(
      150
    )
  })

  it('reclaims fork-copied turns when the owning original file is deleted', async () => {
    const root = await makeClaudeProjectsRoot()
    const projectDir = join(root, '.claude', 'projects', 'project-a')
    const originalFile = join(projectDir, 'aaaa-original.jsonl')
    const forkFile = join(projectDir, 'bbbb-fork.jsonl')

    const turn = (
      sessionId: string,
      messageId: string,
      requestId: string,
      inputTokens: number
    ): string =>
      JSON.stringify({
        type: 'assistant',
        sessionId,
        timestamp: '2026-04-09T10:00:00.000Z',
        requestId,
        cwd: '/workspace/repo-a',
        message: {
          id: messageId,
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: inputTokens, output_tokens: 10 }
        }
      })

    await writeFile(originalFile, turn('session-1', 'msg_1', 'req_1', 100))
    await writeFile(
      forkFile,
      [turn('session-2', 'msg_1', 'req_1', 100), turn('session-2', 'msg_9', 'req_9', 50)].join('\n')
    )

    vi.resetModules()
    vi.doMock('os', async () => ({
      ...(await vi.importActual<typeof Os>('os')),
      homedir: () => root
    }))
    const { scanClaudeUsageFiles } = await import('./scanner')

    const first = await scanClaudeUsageFiles([])
    expect(first.dailyAggregates.reduce((sum, aggregate) => sum + aggregate.inputTokens, 0)).toBe(
      150
    )
    expect(first.processedFiles[0]?.ownedDedupeKeys).toEqual(['msg_1:req_1'])
    expect(first.processedFiles[1]?.ownedDedupeKeys).toEqual(['msg_9:req_9'])

    // Deleting the owner must reparse deferred forks so they can re-claim the
    // copied turn instead of permanently under-counting.
    await rm(originalFile)

    const second = await scanClaudeUsageFiles([], first.processedFiles)
    expect(second.dailyAggregates.reduce((sum, aggregate) => sum + aggregate.inputTokens, 0)).toBe(
      150
    )
    expect(second.processedFiles).toHaveLength(1)
    expect(second.processedFiles[0]?.ownedDedupeKeys).toEqual(['msg_1:req_1', 'msg_9:req_9'])
  })

  it('keeps unrelated cached transcripts when a different owner file is deleted', async () => {
    const root = await makeClaudeProjectsRoot()
    const projectDir = join(root, '.claude', 'projects', 'project-a')
    const originalFile = join(projectDir, 'aaaa-original.jsonl')
    const forkFile = join(projectDir, 'bbbb-fork.jsonl')
    const unrelatedFile = join(projectDir, 'cccc-unrelated.jsonl')

    const turn = (
      sessionId: string,
      messageId: string,
      requestId: string,
      inputTokens: number
    ): string =>
      JSON.stringify({
        type: 'assistant',
        sessionId,
        timestamp: '2026-04-09T10:00:00.000Z',
        requestId,
        cwd: '/workspace/repo-a',
        message: {
          id: messageId,
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: inputTokens, output_tokens: 10 }
        }
      })

    await writeFile(originalFile, turn('session-1', 'msg_1', 'req_1', 100))
    await writeFile(
      forkFile,
      [turn('session-2', 'msg_1', 'req_1', 100), turn('session-2', 'msg_9', 'req_9', 50)].join('\n')
    )
    await writeFile(unrelatedFile, turn('session-3', 'msg_u', 'req_u', 25))

    vi.resetModules()
    vi.doMock('os', async () => ({
      ...(await vi.importActual<typeof Os>('os')),
      homedir: () => root
    }))
    const { scanClaudeUsageFiles } = await import('./scanner')

    const first = await scanClaudeUsageFiles([])
    const unrelatedBefore = first.processedFiles.find((file) => file.path === unrelatedFile)
    expect(unrelatedBefore?.hasDeferredClaims).toBe(false)
    expect(unrelatedBefore?.ownedDedupeKeys).toEqual(['msg_u:req_u'])

    await rm(originalFile)

    const second = await scanClaudeUsageFiles([], first.processedFiles)
    const unrelatedAfter = second.processedFiles.find((file) => file.path === unrelatedFile)
    // Unrelated files must keep their cached projection identity (stat-only path).
    expect(unrelatedAfter).toBe(unrelatedBefore)
    expect(second.dailyAggregates.reduce((sum, aggregate) => sum + aggregate.inputTokens, 0)).toBe(
      175
    )
  })

  it('canonicalizes repeated cwd paths once per scan file', async () => {
    const root = await makeClaudeProjectsRoot()
    const projectDir = join(root, '.claude', 'projects', 'project-a')
    const transcriptFile = join(projectDir, 'session-1.jsonl')
    const repeatedCwd = '/workspace/repo-a/packages/app'

    await writeFile(
      transcriptFile,
      [1, 2, 3]
        .map((index) =>
          JSON.stringify({
            type: 'assistant',
            sessionId: 'session-1',
            timestamp: `2026-04-09T10:0${index}:00.000Z`,
            cwd: repeatedCwd,
            message: {
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 100,
                output_tokens: 20
              }
            }
          })
        )
        .join('\n')
    )

    const realpathCalls: string[] = []
    vi.resetModules()
    vi.doMock('os', async () => ({
      ...(await vi.importActual<typeof Os>('os')),
      homedir: () => root
    }))
    vi.doMock('fs/promises', async () => ({
      ...(await vi.importActual<typeof FsPromises>('fs/promises')),
      realpath: vi.fn(async (pathValue: string) => {
        realpathCalls.push(pathValue)
        return pathValue
      })
    }))
    const { scanClaudeUsageFiles } = await import('./scanner')

    await scanClaudeUsageFiles([
      {
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        path: '/workspace/repo-a',
        displayName: 'Repo A'
      }
    ])

    expect(realpathCalls.filter((pathValue) => pathValue === repeatedCwd)).toHaveLength(1)
  })
})
