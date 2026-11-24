import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  claudeToolReturnWithoutRequest,
  readClaudeToolReturnWithoutRequest
} from './claude-tool-return-without-request'

// Row shapes as Claude 2.1.325 writes them (trimmed to the fields read).
const request = (at: string) => ({ type: 'api-request', timestamp: at, querySource: 'sdk' })
const assistant = (id: string, toolIds: string[], stopReason: string | null = 'tool_use') => ({
  type: 'assistant',
  isSidechain: false,
  message: {
    id,
    stop_reason: stopReason,
    content: toolIds.map((toolId) => ({ type: 'tool_use', id: toolId, name: 'Bash', input: {} }))
  }
})
const result = (at: string, ...toolIds: string[]) => ({
  type: 'user',
  isSidechain: false,
  timestamp: at,
  message: {
    role: 'user',
    content: toolIds.map((toolId) => ({ type: 'tool_result', tool_use_id: toolId, content: 'ok' }))
  }
})
const attachment = { type: 'attachment', isSidechain: false, attachment: { type: 'hook_success' } }
const RETURNED = '2026-11-20T21:17:08.000Z'

function transcript(...rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

// The proven stall: a request built for the last turn, its tool returned, and nothing since.
const STALLED = [
  request('2026-11-20T21:09:00.000Z'),
  assistant('msg_1', ['tool_a']),
  result(RETURNED, 'tool_a'),
  attachment
]

describe('claudeToolReturnWithoutRequest', () => {
  it('names when the tool returned once no request followed its result', () => {
    expect(claudeToolReturnWithoutRequest(transcript(...STALLED))).toBe(Date.parse(RETURNED))
  })

  it('proves nothing in a session with no request rows (recorder off or skipped)', () => {
    expect(
      claudeToolReturnWithoutRequest(
        transcript(assistant('msg_1', ['tool_a']), result(RETURNED, 'tool_a'))
      )
    ).toBeNull()
  })

  it('sees the request that followed the result', () => {
    expect(
      claudeToolReturnWithoutRequest(transcript(...STALLED, request('2026-11-20T21:17:08.020Z')))
    ).toBeNull()
  })

  it('waits on a sibling tool of the same reply that has no result yet', () => {
    expect(
      claudeToolReturnWithoutRequest(
        transcript(
          request('2026-11-20T21:09:00.000Z'),
          assistant('msg_1', ['tool_a']),
          assistant('msg_1', ['tool_b']),
          result(RETURNED, 'tool_a')
        )
      )
    ).toBeNull()
  })

  it('reads a reply still streaming (no stop reason yet) as a request in flight', () => {
    expect(
      claudeToolReturnWithoutRequest(
        transcript(
          request('2026-11-20T21:09:00.000Z'),
          assistant('msg_1', ['tool_a'], null),
          result(RETURNED, 'tool_a')
        )
      )
    ).toBeNull()
  })

  it('reads a compaction, a typed prompt, or a newer reply after the result as no stall', () => {
    const after = [
      { type: 'system', subtype: 'compact_boundary', isSidechain: false },
      { type: 'user', isSidechain: false, message: { role: 'user', content: 'keep going' } },
      assistant('msg_2', [])
    ]
    for (const row of after) {
      expect(claudeToolReturnWithoutRequest(transcript(...STALLED, row))).toBeNull()
    }
  })

  it('ignores a subagent row and a cut first line, and reads an unknown result as doubt', () => {
    const sidechain = { ...result('2026-11-20T21:20:00.000Z', 'sub_tool'), isSidechain: true }
    expect(
      claudeToolReturnWithoutRequest(`{"type":"assis\n${transcript(...STALLED, sidechain)}`)
    ).toBe(Date.parse(RETURNED))
    expect(
      claudeToolReturnWithoutRequest(transcript(...STALLED, result(RETURNED, 'tool_unknown')))
    ).toBeNull()
  })

  it('proves nothing when only an earlier turn had its request recorded (recorder off since)', () => {
    const prompt = { type: 'user', isSidechain: false, message: { role: 'user', content: 'next' } }
    expect(
      claudeToolReturnWithoutRequest(
        transcript(...STALLED, prompt, assistant('msg_2', ['tool_b']), result(RETURNED, 'tool_b'))
      )
    ).toBeNull()
  })

  it('reads a row still being appended, or an unreadable row after the result, as doubt', () => {
    expect(
      claudeToolReturnWithoutRequest(`${transcript(...STALLED)}{"type":"api-request",`)
    ).toBeNull()
    expect(claudeToolReturnWithoutRequest(`${transcript(...STALLED)}{"type":"api-req\n`)).toBeNull()
    // The unreadable row may have held a sibling call that is still running.
    const [requestRow, toolA, resultA] = STALLED
    expect(
      claudeToolReturnWithoutRequest(
        `${transcript(requestRow, toolA)}{"type":"assistant",\n${transcript(resultA)}`
      )
    ).toBeNull()
  })
})

describe('readClaudeToolReturnWithoutRequest', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the return only once it is older than the quiet wait, and nothing for a missing file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-tool-return-'))
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, transcript(...STALLED))
    const returned = Date.parse(RETURNED)
    const tenMin = 10 * 60_000
    await expect(readClaudeToolReturnWithoutRequest(path, tenMin, returned + tenMin)).resolves.toBe(
      returned
    )
    await expect(
      readClaudeToolReturnWithoutRequest(path, tenMin, returned + tenMin - 1)
    ).resolves.toBeNull()
    await expect(
      readClaudeToolReturnWithoutRequest(join(dir, 'missing.jsonl'), tenMin, returned + tenMin)
    ).resolves.toBeNull()
  })
})
