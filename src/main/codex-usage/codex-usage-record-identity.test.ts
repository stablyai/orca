import { describe, expect, it } from 'vitest'
import { parseCodexUsageRecord, type CodexUsageParseContext } from './codex-usage-record-parser'

function key(id: string, root?: string, turn?: string, timestamp = '2026-09-01T00:00:00Z') {
  const context: CodexUsageParseContext = {
    sessionId: id,
    sessionCwd: null,
    currentCwd: null,
    currentModel: null,
    previousTotals: null
  }
  parseCodexUsageRecord(
    JSON.stringify({ type: 'session_meta', payload: { id, session_id: root } }),
    context
  )
  parseCodexUsageRecord(
    JSON.stringify({ type: 'turn_context', payload: { turn_id: turn } }),
    context
  )
  const usage = { input_tokens: 10, total_tokens: 10 }
  return parseCodexUsageRecord(
    JSON.stringify({
      type: 'event_msg',
      timestamp,
      payload: {
        type: 'token_count',
        info: { total_token_usage: usage, last_token_usage: usage }
      }
    }),
    context
  )?.eventKey
}

describe('Codex usage ownership identity', () => {
  it('counts repeated last-only requests separately', () => {
    const context: CodexUsageParseContext = {
      sessionId: 'a',
      sessionCwd: null,
      currentCwd: null,
      currentModel: null,
      previousTotals: null
    }
    const line = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-09-01T00:00:00Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, total_tokens: 10 } }
      }
    })
    const first = parseCodexUsageRecord(line, context)
    const second = parseCodexUsageRecord(line, context)
    expect(first?.eventKey).not.toBe(second?.eventKey)
    expect(first?.totalTokens).toBe(10)
    expect(second?.totalTokens).toBe(10)
  })

  it('retains unrelated legacy sessions with identical timestamps and usage', () => {
    expect(key('a')).not.toBe(key('b'))
  })
  it('retains independent fork turns with identical usage', () => {
    expect(key('a', 'root', 'turn-a')).not.toBe(key('b', 'root', 'turn-b'))
  })
  it('deduplicates a copied turn whose timestamp and file session id changed', () => {
    expect(key('a', 'root', 'turn')).toBe(key('b', 'root', 'turn', '2026-09-02T00:00:00Z'))
  })
})
