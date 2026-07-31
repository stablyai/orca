import { describe, expect, it, vi } from 'vitest'
import {
  extractCodexSessionUsedPercentFromLog,
  readLatestCodexSessionUsedPercent
} from './codex-session-log-usage'

function tokenCountLine(info: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: '2026-07-31T00:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'token_count', info }
  })
}

describe('extractCodexSessionUsedPercentFromLog', () => {
  it('computes used percent from the last token_count event', () => {
    const content = [
      tokenCountLine({
        total_token_usage: { total_tokens: 1000 },
        model_context_window: 10_000
      }),
      tokenCountLine({
        total_token_usage: { total_tokens: 4000 },
        model_context_window: 10_000
      })
    ].join('\n')
    expect(extractCodexSessionUsedPercentFromLog(content)).toBe(40)
  })

  it('falls back to last_token_usage when total_token_usage is absent', () => {
    const content = tokenCountLine({
      last_token_usage: { total_tokens: 2_584 },
      model_context_window: 258_400
    })
    expect(extractCodexSessionUsedPercentFromLog(content)).toBe(1)
  })

  it('ignores non-token_count lines and malformed JSON', () => {
    const content = [
      'not json',
      JSON.stringify({ type: 'session_meta', payload: { id: 'abc' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'hi' }
      }),
      tokenCountLine({ total_token_usage: { total_tokens: 50 }, model_context_window: 100 })
    ].join('\n')
    expect(extractCodexSessionUsedPercentFromLog(content)).toBe(50)
  })

  it('returns null when no token_count event is present', () => {
    const content = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'hi' }
    })
    expect(extractCodexSessionUsedPercentFromLog(content)).toBeNull()
  })

  it('skips a token_count event missing a valid model_context_window', () => {
    const content = [
      tokenCountLine({ total_token_usage: { total_tokens: 10 }, model_context_window: 0 }),
      tokenCountLine({ total_token_usage: { total_tokens: 30 }, model_context_window: 100 })
    ].join('\n')
    expect(extractCodexSessionUsedPercentFromLog(content)).toBe(30)
  })

  it('clamps used percent to [0, 100]', () => {
    const content = tokenCountLine({
      total_token_usage: { total_tokens: 999_999 },
      model_context_window: 100
    })
    expect(extractCodexSessionUsedPercentFromLog(content)).toBe(100)
  })

  it('returns null for empty content', () => {
    expect(extractCodexSessionUsedPercentFromLog('')).toBeNull()
  })
})

describe('readLatestCodexSessionUsedPercent', () => {
  it('reads the most recently modified session file', async () => {
    const listFiles = vi.fn().mockResolvedValue(['/sessions/old.jsonl', '/sessions/new.jsonl'])
    const statFile = vi.fn(async (filePath: string) => ({
      mtimeMs: filePath.includes('new') ? 2_000 : 1_000
    }))
    const readFileFn = vi.fn(async (filePath: string) =>
      filePath.includes('new')
        ? tokenCountLine({ total_token_usage: { total_tokens: 25 }, model_context_window: 100 })
        : tokenCountLine({ total_token_usage: { total_tokens: 99 }, model_context_window: 100 })
    )
    const result = await readLatestCodexSessionUsedPercent(listFiles, statFile, readFileFn)
    expect(result).toBe(25)
    expect(readFileFn).toHaveBeenCalledWith('/sessions/new.jsonl')
  })

  it('returns null when there are no session files', async () => {
    const result = await readLatestCodexSessionUsedPercent(
      vi.fn().mockResolvedValue([]),
      vi.fn(),
      vi.fn()
    )
    expect(result).toBeNull()
  })

  it('skips files whose stat call fails and still uses a readable one', async () => {
    const listFiles = vi.fn().mockResolvedValue(['/sessions/broken.jsonl', '/sessions/ok.jsonl'])
    const statFile = vi.fn(async (filePath: string) => {
      if (filePath.includes('broken')) {
        throw new Error('permission denied')
      }
      return { mtimeMs: 1_000 }
    })
    const readFileFn = vi.fn(async () =>
      tokenCountLine({ total_token_usage: { total_tokens: 10 }, model_context_window: 100 })
    )
    const result = await readLatestCodexSessionUsedPercent(listFiles, statFile, readFileFn)
    expect(result).toBe(10)
  })

  it('returns null when listing session files throws', async () => {
    const result = await readLatestCodexSessionUsedPercent(
      vi.fn().mockRejectedValue(new Error('fs unavailable')),
      vi.fn(),
      vi.fn()
    )
    expect(result).toBeNull()
  })

  it('returns null when reading the latest file throws', async () => {
    const result = await readLatestCodexSessionUsedPercent(
      vi.fn().mockResolvedValue(['/sessions/a.jsonl']),
      vi.fn().mockResolvedValue({ mtimeMs: 1_000 }),
      vi.fn().mockRejectedValue(new Error('read failed'))
    )
    expect(result).toBeNull()
  })

  it('falls back to an older session file when the newest has no usable token_count event', async () => {
    const listFiles = vi
      .fn()
      .mockResolvedValue(['/sessions/older.jsonl', '/sessions/newest.jsonl'])
    const statFile = vi.fn(async (filePath: string) => ({
      mtimeMs: filePath.includes('newest') ? 2_000 : 1_000
    }))
    const readFileFn = vi.fn(async (filePath: string) =>
      filePath.includes('newest')
        ? JSON.stringify({ type: 'session_meta', payload: { id: 'abc' } })
        : tokenCountLine({ total_token_usage: { total_tokens: 40 }, model_context_window: 100 })
    )
    const result = await readLatestCodexSessionUsedPercent(listFiles, statFile, readFileFn)
    expect(result).toBe(40)
    expect(readFileFn).toHaveBeenCalledWith('/sessions/newest.jsonl')
    expect(readFileFn).toHaveBeenCalledWith('/sessions/older.jsonl')
  })

  it('falls back to an older session file when reading the newest throws', async () => {
    const listFiles = vi
      .fn()
      .mockResolvedValue(['/sessions/older.jsonl', '/sessions/newest.jsonl'])
    const statFile = vi.fn(async (filePath: string) => ({
      mtimeMs: filePath.includes('newest') ? 2_000 : 1_000
    }))
    const readFileFn = vi.fn(async (filePath: string) => {
      if (filePath.includes('newest')) {
        throw new Error('permission denied')
      }
      return tokenCountLine({ total_token_usage: { total_tokens: 5 }, model_context_window: 100 })
    })
    const result = await readLatestCodexSessionUsedPercent(listFiles, statFile, readFileFn)
    expect(result).toBe(5)
  })
})
