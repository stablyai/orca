import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: homedirMock
}))

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

function assistantRow(outputTokens: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'owner-session',
    timestamp: '2026-10-09T12:00:00.000Z',
    requestId: 'request-shared',
    message: {
      id: 'message-shared',
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 2,
        output_tokens: outputTokens,
        cache_read_input_tokens: 81_365,
        cache_creation_input_tokens: 1_336
      }
    }
  })}\n`
}

it.each(['small', 'resumable'])(
  'counts a request copied across %s transcripts once with its fullest tokens',
  async (size) => {
    const { scanClaudeUsageFiles } = await import('./scanner')
    const { readClaudeUsageSourceCache, writeClaudeUsageSourceCache } =
      await import('./persisted-source-cache')
    const scan = (previous: Parameters<typeof scanClaudeUsageFiles>[1] = []) =>
      scanClaudeUsageFiles([], previous, undefined, [])
    const prefix =
      size === 'resumable'
        ? `${JSON.stringify({ type: 'user', content: '界'.repeat(12_000) })}\n`
        : ''
    const forkPath = join(projectDir, 'zzzz-fork.jsonl')
    await writeFile(join(projectDir, 'aaaa-owner.jsonl'), prefix + assistantRow(10))
    await writeFile(forkPath, prefix + assistantRow(10) + assistantRow(3_080))
    const expected = {
      turnCount: 1,
      totalInputTokens: 2,
      totalOutputTokens: 3_080,
      totalCacheReadTokens: 81_365,
      totalCacheWriteTokens: 1_336
    }

    const first = await scan()
    expect(first.sessions).toHaveLength(1)
    expect(first.sessions[0]).toMatchObject(expected)

    const ref = {
      path: join(root, 'sources.json'),
      schemaVersion: 7,
      worktreeFingerprint: '[]',
      reuse: true
    }
    await writeClaudeUsageSourceCache(ref, first.processedFiles)
    const restarted = await scan((await readClaudeUsageSourceCache(ref)).sources)
    expect(restarted.sessions[0]).toMatchObject(expected)

    await writeFile(forkPath, prefix + assistantRow(30))
    const lowered = await scan(restarted.processedFiles)
    expect(lowered.sessions[0]).toMatchObject({ ...expected, totalOutputTokens: 30 })
    expect(lowered.sessions).toEqual((await scan()).sessions)
  }
)
