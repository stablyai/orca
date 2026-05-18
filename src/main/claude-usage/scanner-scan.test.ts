import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'os'
import type * as FsPromises from 'fs/promises'

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
