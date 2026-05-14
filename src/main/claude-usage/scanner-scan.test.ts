import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'os'

const tempRoots: string[] = []

async function makeClaudeProjectsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-usage-'))
  tempRoots.push(root)
  await mkdir(join(root, '.claude', 'projects', 'project-a'), { recursive: true })
  return root
}

afterEach(async () => {
  vi.doUnmock('os')
  vi.resetModules()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('scanClaudeUsageFiles', () => {
  it('scans transcript files from the configured Claude projects directory', async () => {
    const root = await makeClaudeProjectsRoot()
    const projectDir = join(root, '.claude', 'projects', 'project-a')
    const firstFile = join(projectDir, 'a.jsonl')
    const secondFile = join(projectDir, 'b.jsonl')

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
      [secondFile, 1]
    ])
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['session-2', 'session-1'])
    expect(result.dailyAggregates).toHaveLength(2)
    expect(result.dailyAggregates[0]?.projectLabel).toBe('Repo A')
  })
})
