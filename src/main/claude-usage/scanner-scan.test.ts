import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'

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
})
