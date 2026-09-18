import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let root = ''

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = ''
  }
})

describe('scanDevinUsageFiles', () => {
  it('attributes ATIF usage and reuses an unchanged transcript', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-devin-usage-'))
    const transcripts = join(root, 'transcripts')
    await mkdir(transcripts)
    const transcript = join(transcripts, 'session.json')
    await writeFile(
      transcript,
      JSON.stringify({
        session_id: 'devin-session',
        working_directory: join(root, 'repo', 'worktree'),
        agent: { model_name: 'swe-1-6' },
        steps: [
          {
            metadata: {
              created_at: '2026-09-18T12:00:00Z',
              total_input_tokens: 10,
              output_tokens: 4,
              cache_read_tokens: 3,
              cache_creation_tokens: 2
            }
          }
        ]
      })
    )
    vi.stubEnv('DEVIN_HOME', root)
    vi.resetModules()
    // DEVIN_TRANSCRIPTS_DIR is resolved at module load, so import after the test override.
    const { scanDevinUsageFiles } = await import('./scanner')
    const worktrees = [
      {
        repoId: 'repo',
        worktreeId: 'worktree',
        path: join(root, 'repo', 'worktree'),
        displayName: 'Devin worktree'
      }
    ]

    const first = await scanDevinUsageFiles(worktrees)
    expect(first.sessions).toEqual([
      expect.objectContaining({
        sessionId: 'devin-session',
        totalTokens: 19,
        primaryWorktreeId: 'worktree'
      })
    ])
    expect(first.dailyAggregates).toEqual([
      expect.objectContaining({
        inputTokens: 10,
        cachedInputTokens: 5,
        outputTokens: 4,
        projectLabel: 'Devin worktree'
      })
    ])

    const second = await scanDevinUsageFiles(worktrees, first.processedFiles)
    expect(second.processedFiles[0]).toBe(first.processedFiles[0])
    expect(second.sessions).toEqual(first.sessions)
  })

  it('skips a corrupt transcript without caching it and still aggregates valid ones', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-devin-usage-'))
    const transcripts = join(root, 'transcripts')
    await mkdir(transcripts)
    const validPath = join(transcripts, 'valid.json')
    const corruptPath = join(transcripts, 'corrupt.json')
    await writeFile(
      validPath,
      JSON.stringify({
        session_id: 'devin-valid',
        working_directory: join(root, 'repo', 'worktree'),
        agent: { model_name: 'swe-1-6' },
        steps: [
          {
            metadata: {
              created_at: '2026-09-18T12:00:00Z',
              total_input_tokens: 10,
              output_tokens: 4,
              cache_read_tokens: 3,
              cache_creation_tokens: 2
            }
          }
        ]
      })
    )
    await writeFile(corruptPath, '{"session_id": "devin-corrupt", "steps": [')
    vi.stubEnv('DEVIN_HOME', root)
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // DEVIN_TRANSCRIPTS_DIR is resolved at module load, so import after the test override.
    const { scanDevinUsageFiles } = await import('./scanner')
    const worktrees = [
      {
        repoId: 'repo',
        worktreeId: 'worktree',
        path: join(root, 'repo', 'worktree'),
        displayName: 'Devin worktree'
      }
    ]

    const onFilesScanned = vi.fn()
    const result = await scanDevinUsageFiles(worktrees, [], onFilesScanned)

    expect(result.sessions).toEqual([
      expect.objectContaining({ sessionId: 'devin-valid', totalTokens: 19 })
    ])
    expect(result.dailyAggregates).toEqual([
      expect.objectContaining({ inputTokens: 10, cachedInputTokens: 5, outputTokens: 4 })
    ])
    expect(result.processedFiles.map((file) => file.path)).toEqual([validPath])
    expect(onFilesScanned).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[devin-usage]'))
    warn.mockRestore()
  })
})
