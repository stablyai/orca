import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCodexSessionFile } from './session-scanner-codex-parser'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'

let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('Codex resumable parser fast path', () => {
  it('matches the one-shot parser without JSON-parsing proven irrelevant large records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-fast-path-'))
    tempRoots.push(root)
    const path = join(
      root,
      'sessions',
      '2026',
      '08',
      '20',
      'rollout-2026-08-20T10-00-00-fast-path.jsonl'
    )
    await mkdir(dirname(path), { recursive: true })
    const largePayload = 'x'.repeat(2 * 1024 * 1024)
    const records = [
      {
        timestamp: '2026-08-20T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'fast-path-session', cwd: '/repo/app' }
      },
      {
        timestamp: '2026-08-20T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: 'Keep visible messages exact' }]
        }
      },
      {
        timestamp: '2026-08-20T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', output: largePayload }
      },
      {
        timestamp: '2026-08-20T10:00:03.000Z',
        type: 'world_state',
        payload: { state: largePayload }
      },
      {
        timestamp: '2026-08-20T10:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 120 } }
        }
      },
      {
        timestamp: '2026-08-20T10:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Visible answer' }]
        }
      },
      {
        timestamp: '2026-08-20T10:00:06.000Z',
        type: 'event_msg',
        payload: {
          metadata: { payload: { type: 'turn_aborted' } },
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 150 } }
        }
      },
      {
        timestamp: '2026-08-20T10:00:07.000Z',
        type: 'event_msg',
        payload: { type: 'future_event', value: 1 }
      },
      // Reordered/unknown envelopes must take the compatibility fallback.
      { type: 'future_record', timestamp: '2026-08-20T10:00:08.000Z', payload: { value: 1 } },
      {
        timestamp: '2026-08-20T10:00:09.000Z',
        type: 'compacted',
        payload: { replacement_history: largePayload }
      }
    ]
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    const fileStat = await stat(path)
    const file = {
      path,
      mtimeMs: fileStat.mtimeMs,
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size
    }
    const expected = await parseCodexSessionFile(file, process.platform, null)
    const candidate: SessionFileCandidate = { agent: 'codex', file, codexHome: null }

    const parseSpy = vi.spyOn(JSON, 'parse')
    const actual = await parseAgentSessionFileCached(candidate, process.platform)

    expect(actual).toEqual(expected)
    expect(actual).toMatchObject({
      messageCount: 2,
      totalTokens: 150,
      updatedAt: '2026-08-20T10:00:09.000Z'
    })
    expect(parseSpy).toHaveBeenCalledTimes(7)
    expect(
      parseSpy.mock.calls.some(([input]) => typeof input === 'string' && input.length > 1024 * 1024)
    ).toBe(false)
  })

  it('stops reading as soon as session_meta rejects a worker transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-worker-fast-stop-'))
    tempRoots.push(root)
    const path = join(root, 'rollout-worker.jsonl')
    const sessionMeta = JSON.stringify({
      timestamp: '2026-08-20T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'worker-session', source: { subagent: { thread_spawn: true } } }
    })
    const ignoredTail = JSON.stringify({
      timestamp: '2026-08-20T10:00:01.000Z',
      type: 'compacted',
      payload: { replacement_history: 'x'.repeat(4 * 1024 * 1024) }
    })
    await writeFile(path, `${sessionMeta}\n${ignoredTail}\n`)
    const fileStat = await stat(path)
    const stats = createSessionParseStats()

    const session = await parseAgentSessionFileCached(
      {
        agent: 'codex',
        file: {
          path,
          mtimeMs: fileStat.mtimeMs,
          modifiedAt: fileStat.mtime.toISOString(),
          sizeBytes: fileStat.size
        },
        codexHome: null
      },
      process.platform,
      stats
    )

    expect(session).toBeNull()
    expect(stats.bytesRead).toBeLessThan(fileStat.size / 2)
  })
})
