import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { scanClaudeUsageFiles } from './scanner'
import type { ClaudeUsagePersistedFile } from './types'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: homedirMock
}))

vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  claudeProfileHistoryDirs: () => []
}))

type ScanResult = Awaited<ReturnType<typeof scanClaudeUsageFiles>>

let root: string
let transcriptPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-usage-long-context-'))
  homedirMock.mockReturnValue(root)
  const projectDir = join(root, '.claude', 'projects', 'project-a')
  await mkdir(projectDir, { recursive: true })
  transcriptPath = join(projectDir, 'long-context-session.jsonl')
  vi.resetModules()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function assistantRow(key: string, model: string, cacheReadTokens: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'long-context-session',
    timestamp: '2026-10-09T12:00:00.000Z',
    cwd: join(root, 'workspace'),
    requestId: `request-${key}`,
    message: {
      id: `message-${key}`,
      model,
      usage: { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: cacheReadTokens }
    }
  })}\n`
}

// Resume checkpoints require at least MIN_RESUMABLE_PREFIX_BYTES.

async function scan(previous: ClaudeUsagePersistedFile[] = []): Promise<ScanResult> {
  const { scanClaudeUsageFiles } = await import('./scanner')
  return scanClaudeUsageFiles([], previous, undefined, [])
}

describe('Claude usage long-context subsets', () => {
  it('records only requests whose prompt crosses their own model threshold', async () => {
    await writeFile(
      transcriptPath,
      assistantRow('haiku-long', 'claude-haiku-5-5', 100_000) +
        assistantRow('haiku-short', 'claude-haiku-5-5', 98_000) +
        assistantRow('sonnet-short', 'claude-sonnet-4-5', 150_000) +
        assistantRow('flat', 'claude-sonnet-4-6', 500_000)
    )

    const result = await scan()

    const byModel = new Map(result.dailyAggregates.map((row) => [row.model, row]))
    expect(byModel.get('claude-haiku-5-5')?.longContext).toEqual({
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0
    })
    expect(byModel.get('claude-haiku-5-5')?.cacheReadTokens).toBe(198_000)
    expect(byModel.get('claude-sonnet-4-5')?.longContext).toBeUndefined()
    expect(byModel.get('claude-sonnet-4-6')?.longContext).toBeUndefined()
    expect(result.sessions[0]?.locationBreakdown[0]?.longContext?.cacheReadTokens).toBe(100_000)
  })
})
