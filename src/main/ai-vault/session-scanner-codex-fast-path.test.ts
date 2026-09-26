import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCodexSessionFile } from './session-scanner-codex-parser'
import { readCodexTimelineOnlyRecord } from './session-scanner-codex-record-fast-path'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import type { FileWithMtime, SessionFileCandidate } from './session-scanner-types'

// Codex serializes `RolloutLine` as `timestamp` + the adjacently tagged
// `RolloutItem`; payload enums (`ResponseItem`, `EventMsg`) are internally
// tagged, so their own `type` leads. Every fixture below matches that spelling.
const PAD = 'x'.repeat(2048)

function record(type: string, payload: Record<string, unknown>, timestamp: string): string {
  return JSON.stringify({ timestamp, type, payload })
}

// Padded past the fast path's prefix limit: an undersized record is parsed
// exactly either way, so only oversized fixtures exercise the prefix match.
function paddedPayload(payloadType: string, extra: Record<string, unknown> = {}) {
  return { type: payloadType, ...extra, pad: PAD }
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

describe('readCodexTimelineOnlyRecord', () => {
  // The fast path is the complement of what `consumeCodexRecordLine` reads, so
  // every record that feeds a visible field must fail the prefix match even
  // when it is large — a >1KiB opening prompt is ordinary, and it is the title.
  it.each([
    ['session_meta', record('session_meta', { id: 'a', pad: PAD }, '2026-08-20T10:00:00.000Z')],
    [
      'turn_context',
      record('turn_context', { cwd: '/repo', pad: PAD }, '2026-08-20T10:00:00.000Z')
    ],
    [
      'response_item/message',
      record(
        'response_item',
        paddedPayload('message', { role: 'user' }),
        '2026-08-20T10:00:00.000Z'
      )
    ],
    [
      'event_msg/user_message',
      record('event_msg', paddedPayload('user_message'), '2026-08-20T10:00:00.000Z')
    ],
    [
      'event_msg/agent_message',
      record('event_msg', paddedPayload('agent_message'), '2026-08-20T10:00:00.000Z')
    ],
    [
      'event_msg/item_completed',
      record('event_msg', paddedPayload('item_completed'), '2026-08-20T10:00:00.000Z')
    ],
    [
      'event_msg/token_count',
      record('event_msg', paddedPayload('token_count'), '2026-08-20T10:00:00.000Z')
    ]
  ])('keeps %s on the full parser', (_label, line) => {
    expect(readCodexTimelineOnlyRecord(Buffer.from(line))).toBeNull()
  })

  it.each([
    ['compacted', record('compacted', { message: PAD }, '2026-08-20T10:00:00.000Z')],
    [
      'response_item/function_call_output',
      record('response_item', paddedPayload('function_call_output'), '2026-08-20T10:00:00.000Z')
    ],
    [
      'response_item/image_generation_call',
      record('response_item', paddedPayload('image_generation_call'), '2026-08-20T10:00:00.000Z')
    ],
    [
      'response_item/reasoning',
      record('response_item', paddedPayload('reasoning'), '2026-08-20T10:00:00.000Z')
    ],
    [
      'event_msg/task_complete',
      record('event_msg', paddedPayload('task_complete'), '2026-08-20T10:00:00.000Z')
    ],
    [
      'event_msg/exec_command_output_delta',
      record('event_msg', paddedPayload('exec_command_output_delta'), '2026-08-20T10:00:00.000Z')
    ]
  ])('takes %s off the full parser', (_label, line) => {
    expect(readCodexTimelineOnlyRecord(Buffer.from(line))).toEqual({
      timestamp: '2026-08-20T10:00:00.000Z'
    })
  })

  it('falls back for small, reordered, or prefix-ambiguous records', () => {
    const small = record('compacted', { message: 'short' }, '2026-08-20T10:00:00.000Z')
    expect(readCodexTimelineOnlyRecord(Buffer.from(small))).toBeNull()
    const reordered = `${JSON.stringify({ type: 'compacted', timestamp: '2026-08-20T10:00:00.000Z', payload: { message: PAD } })}`
    expect(readCodexTimelineOnlyRecord(Buffer.from(reordered))).toBeNull()
    // `type` pushed past the bounded prefix leaves the payload unidentified.
    const lateType = `{"timestamp":"2026-08-20T10:00:00.000Z","type":"response_item","payload":{"pad":"${PAD}","type":"reasoning"}}`
    expect(readCodexTimelineOnlyRecord(Buffer.from(lateType))).toBeNull()
  })
})

describe('Codex resumable parser fast path', () => {
  it('matches the one-shot parser without JSON-parsing proven irrelevant large records', async () => {
    // Distinct fillers so the assertion can name which large records the fast
    // path skipped and which correctly fell back to the full parser.
    const skippedFiller = `skipped-${'x'.repeat(2 * 1024 * 1024)}`
    const fallbackFiller = `fallback-${'x'.repeat(2 * 1024 * 1024)}`
    const file = await writeTranscript(
      [
        record(
          'session_meta',
          { id: 'fast-path-session', cwd: '/repo/app' },
          '2026-08-20T10:00:00.000Z'
        ),
        // A long opening prompt is the session title; it must survive the size gate.
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
        // A nested `payload.type` must not be mistaken for the record's own.
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
        // Reordered envelopes take the compatibility fallback.
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
    // A reordered envelope is not proven irrelevant, so it still parses whole.
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

  it('never re-reads a worker transcript that later grew', async () => {
    const file = await writeTranscript(
      [
        record(
          'session_meta',
          { id: 'worker-session', thread_source: 'subagent' },
          '2026-08-20T10:00:00.000Z'
        ),
        record('compacted', { message: 'x'.repeat(1024 * 1024) }, '2026-08-20T10:00:01.000Z')
      ],
      'rollout-2026-08-20T10-00-00-worker-grown.jsonl'
    )
    const candidate: SessionFileCandidate = { agent: 'codex', file, codexHome: null }
    await parseAgentSessionFileCached(candidate, process.platform)

    const grown = createSessionParseStats()
    const session = await parseAgentSessionFileCached(
      { ...candidate, file: { ...file, mtimeMs: file.mtimeMs + 1, sizeBytes: 99_000_000 } },
      process.platform,
      grown
    )

    expect(session).toBeNull()
    expect(grown.bytesRead).toBe(0)
    // Reported apart from `incremental` so the scan span shows a dismissal, not
    // an incremental parse that happened to read nothing.
    expect(grown).toMatchObject({ earlyStopped: 1, incremental: 0, fullParses: 0 })
  })
})
