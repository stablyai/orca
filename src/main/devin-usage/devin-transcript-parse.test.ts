import { describe, expect, it } from 'vitest'
import type { DevinSessionIndexRow, DevinSessionsIndex } from '../ai-vault/session-scanner-devin-db'
import { parseDevinTranscriptForUsage } from './devin-transcript-parse'

function indexOf(rows: Record<string, Partial<DevinSessionIndexRow>>): DevinSessionsIndex {
  const index: DevinSessionsIndex = new Map()
  for (const [id, row] of Object.entries(rows)) {
    index.set(id, {
      workingDirectory: null,
      title: null,
      model: null,
      createdAt: null,
      lastActivityAt: null,
      hidden: false,
      ...row
    })
  }
  return index
}

describe('parseDevinTranscriptForUsage', () => {
  it('treats ATIF cached_tokens as a subset of prompt_tokens', () => {
    const parsed = parseDevinTranscriptForUsage(
      '/transcripts/s1.json',
      JSON.stringify({
        session_id: 's1',
        agent: { model_name: 'swe-2' },
        steps: [
          {
            timestamp: '2026-09-01T10:00:00.123456Z',
            metrics: { prompt_tokens: 100, cached_tokens: 30, completion_tokens: 20 }
          }
        ]
      }),
      null
    )

    expect(parsed?.events).toHaveLength(1)
    expect(parsed?.events[0]).toMatchObject({
      sessionId: 's1',
      model: 'swe-2',
      inputTokens: 100,
      cachedInputTokens: 30,
      outputTokens: 20,
      totalTokens: 120,
      estimatedCostUsd: null
    })
  })

  it('folds legacy additive cache buckets into input', () => {
    const parsed = parseDevinTranscriptForUsage(
      '/transcripts/s2.json',
      JSON.stringify({
        session_id: 's2',
        steps: [
          {
            metadata: {
              created_at: '2026-09-01T10:00:00Z',
              metrics: {
                input_tokens: 50,
                output_tokens: 10,
                cache_read_tokens: 30,
                cache_creation_tokens: 5
              }
            }
          }
        ]
      }),
      null
    )

    expect(parsed?.events[0]).toMatchObject({
      inputTokens: 85,
      cachedInputTokens: 35,
      outputTokens: 10,
      totalTokens: 95
    })
  })

  it('does not double-count metrics present in both metadata and step metrics', () => {
    const parsed = parseDevinTranscriptForUsage(
      '/transcripts/s3.json',
      JSON.stringify({
        session_id: 's3',
        steps: [
          {
            timestamp: '2026-09-01T10:00:00Z',
            metadata: { metrics: { prompt_tokens: 40, completion_tokens: 8 } },
            metrics: { prompt_tokens: 40, cached_tokens: 12, completion_tokens: 8 }
          }
        ]
      }),
      null
    )

    expect(parsed?.events[0]).toMatchObject({
      inputTokens: 40,
      cachedInputTokens: 12,
      totalTokens: 48
    })
  })

  it('uses sessions.db for cwd, model fallback, and hidden flag', () => {
    const parsed = parseDevinTranscriptForUsage(
      '/transcripts/s4.json',
      JSON.stringify({
        session_id: 's4',
        steps: [
          {
            timestamp: '2026-09-01T10:00:00Z',
            metrics: { prompt_tokens: 10, completion_tokens: 5 }
          }
        ]
      }),
      indexOf({
        s4: { workingDirectory: 'D:\\Project\\orca', model: 'swe-2-high', hidden: true }
      })
    )

    expect(parsed?.hidden).toBe(true)
    expect(parsed?.events[0]).toMatchObject({ cwd: 'D:\\Project\\orca', model: 'swe-2-high' })
  })

  it('prefers transcript working_directory over the db row', () => {
    const parsed = parseDevinTranscriptForUsage(
      '/transcripts/s5.json',
      JSON.stringify({
        session_id: 's5',
        working_directory: '/home/user/repo',
        steps: [
          {
            timestamp: '2026-09-01T10:00:00Z',
            metrics: { prompt_tokens: 10, completion_tokens: 5 }
          }
        ]
      }),
      indexOf({ s5: { workingDirectory: 'D:\\other', model: null, hidden: false } })
    )

    expect(parsed?.events[0].cwd).toBe('/home/user/repo')
  })

  it('skips steps with no tokens or no timestamp and rejects invalid JSON', () => {
    const parsed = parseDevinTranscriptForUsage(
      '/transcripts/s6.json',
      JSON.stringify({
        session_id: 's6',
        steps: [
          { timestamp: '2026-09-01T10:00:00Z' },
          { metrics: { prompt_tokens: 10, completion_tokens: 1 } },
          {
            timestamp: '2026-09-01T11:00:00Z',
            metrics: { prompt_tokens: 7, completion_tokens: 3 }
          }
        ]
      }),
      null
    )

    expect(parsed?.events).toHaveLength(1)
    expect(parsed?.events[0].totalTokens).toBe(10)

    expect(parseDevinTranscriptForUsage('/t/x.json', '{not json', null)).toBeNull()
    expect(parseDevinTranscriptForUsage('/t/x.json', '42', null)).toBeNull()
  })

  it('falls back to the filename for the session id', () => {
    const parsed = parseDevinTranscriptForUsage(
      '/transcripts/file-id.json',
      JSON.stringify({
        steps: [
          {
            timestamp: '2026-09-01T10:00:00Z',
            metrics: { prompt_tokens: 1, completion_tokens: 1 }
          }
        ]
      }),
      null
    )

    expect(parsed?.sessionId).toBe('file-id')
    expect(parsed?.events[0].sessionId).toBe('file-id')
  })
})
