import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCodexSessionFile } from './session-scanner-codex-parser'
import {
  createSessionParseStats,
  parseAgentSessionFileCached
} from '../../parse-cache/session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from '../../parse-cache/session-parse-cache-store'
import type { FileWithMtime, SessionFileCandidate } from '../../session-scanner-types'

// Match serde field ordering: timestamp/type/payload, with payload type first.
const PAD = 'x'.repeat(2048)

function record(type: string, payload: Record<string, unknown>, timestamp: string): string {
  return JSON.stringify({ timestamp, type, payload })
}

let tempRoots: string[] = []

async function writeTranscript(lines: string[], name: string): Promise<FileWithMtime> {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-fast-path-'))
  tempRoots.push(root)
  const path = join(root, 'sessions', '2026', '08', '20', name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`)
  const fileStat = await stat(path)
  return {
    path,
    mtimeMs: fileStat.mtimeMs,
    modifiedAt: fileStat.mtime.toISOString(),
    sizeBytes: fileStat.size
  }
}

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
    const skippedFiller = `skipped-${'x'.repeat(2 * 1024 * 1024)}`
    const fallbackFiller = `fallback-${'x'.repeat(2 * 1024 * 1024)}`
    const file = await writeTranscript(
      [
        record(
          'session_meta',
          { id: 'fast-path-session', cwd: '/repo/app' },
          '2026-08-20T10:00:00.000Z'
        ),
        record(
          'response_item',
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: `Keep visible messages exact ${PAD}` }]
          },
          '2026-08-20T10:00:01.000Z'
        ),
        record(
          'response_item',
          { type: 'function_call_output', output: skippedFiller },
          '2026-08-20T10:00:02.000Z'
        ),
        record('compacted', { message: skippedFiller }, '2026-08-20T10:00:03.000Z'),
        record(
          'event_msg',
          { type: 'token_count', info: { total_token_usage: { total_tokens: 120 } } },
          '2026-08-20T10:00:04.000Z'
        ),
        record(
          'response_item',
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Visible answer' }]
          },
          '2026-08-20T10:00:05.000Z'
        ),
        record(
          'event_msg',
          {
            metadata: { payload: { type: 'turn_aborted' } },
            type: 'token_count',
            info: { total_token_usage: { total_tokens: 150 } }
          },
          '2026-08-20T10:00:06.000Z'
        ),
        record('event_msg', { type: 'future_event', value: 1 }, '2026-08-20T10:00:07.000Z'),
        JSON.stringify({
          type: 'future_record',
          timestamp: '2026-08-20T10:00:08.000Z',
          payload: { value: fallbackFiller }
        }),
        record('world_state', { state: skippedFiller }, '2026-08-20T10:00:09.000Z')
      ],
      'rollout-2026-08-20T10-00-00-fast-path.jsonl'
    )
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
    const parsedInputs = parseSpy.mock.calls
      .map(([input]) => input)
      .filter((input): input is string => typeof input === 'string')
    expect(parsedInputs.some((input) => input.includes('skipped-xxx'))).toBe(false)
    expect(parsedInputs.some((input) => input.includes('fallback-xxx'))).toBe(true)
  })

  it('stops reading as soon as session_meta rejects a worker transcript', async () => {
    const file = await writeTranscript(
      [
        record(
          'session_meta',
          { id: 'worker-session', source: { subagent: { thread_spawn: true } } },
          '2026-08-20T10:00:00.000Z'
        ),
        record('compacted', { message: 'x'.repeat(4 * 1024 * 1024) }, '2026-08-20T10:00:01.000Z')
      ],
      'rollout-2026-08-20T10-00-00-worker.jsonl'
    )
    const stats = createSessionParseStats()

    const session = await parseAgentSessionFileCached(
      { agent: 'codex', file, codexHome: null },
      process.platform,
      stats
    )

    expect(session).toBeNull()
    expect(stats.bytesRead).toBeLessThan((file.sizeBytes ?? 0) / 2)
  })

  it('indexes a Codex rollout archived as .jsonl.zst (#40312)', async () => {
    const lines = [
      record(
        'session_meta',
        { id: 'archived-session', cwd: '/repo/archived' },
        '2026-08-01T10:00:00.000Z'
      ),
      record(
        'response_item',
        { type: 'message', role: 'user', content: 'archived question' },
        '2026-08-01T10:00:05.000Z'
      ),
      record(
        'response_item',
        { type: 'message', role: 'assistant', content: 'archived answer' },
        '2026-08-01T10:00:10.000Z'
      )
    ]
    const plain = await writeTranscript(lines, 'rollout-2026-08-01T10-00-00-archived.jsonl')
    const file: FileWithMtime = {
      ...plain,
      path: `${plain.path}.zst`,
      sizeBytes: undefined
    }
    await writeFile(file.path, zstdCompressSync(await readFile(plain.path)))
    const fileStat = await stat(file.path)
    file.mtimeMs = fileStat.mtimeMs
    file.sizeBytes = fileStat.size

    const session = await parseAgentSessionFileCached(
      { agent: 'codex', file, codexHome: null },
      process.platform
    )

    expect(session).toMatchObject({
      sessionId: 'archived-session',
      messageCount: 2,
      updatedAt: '2026-08-01T10:00:10.000Z'
    })
  })
})
