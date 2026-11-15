import { describe, expect, it } from 'vitest'

import { parseCodexUsageRecord, type CodexUsageParseContext } from './codex-usage-record-parser'

type Usage = { input: number; cached: number; output: number }

function usageJson({ input, cached, output }: Usage) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output
  }
}

function tokenCountLine(timestamp: string, total: Usage, last?: Usage): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: usageJson(total),
        ...(last ? { last_token_usage: usageJson(last) } : {})
      }
    }
  })
}

function createContext(): CodexUsageParseContext {
  return {
    sessionId: 'session-1',
    sessionCwd: '/workspace/repo',
    currentCwd: '/workspace/repo',
    currentModel: 'gpt-6-astra',
    previousTotals: null
  }
}

function requestLines(requests: { timestamp: string; usage: Usage }[]): string[] {
  const total: Usage = { input: 0, cached: 0, output: 0 }
  return requests.map(({ timestamp, usage }) => {
    total.input += usage.input
    total.cached += usage.cached
    total.output += usage.output
    return tokenCountLine(timestamp, { ...total }, usage)
  })
}

describe('per-request long-context classification', () => {
  it('classifies a request as long only when its prompt exceeds 272,000 tokens', () => {
    const context = createContext()
    const [atThreshold, overThreshold] = requestLines([
      {
        timestamp: '2026-04-09T10:00:00.000Z',
        usage: { input: 272_000, cached: 200_000, output: 1 }
      },
      {
        timestamp: '2026-04-09T10:01:00.000Z',
        usage: { input: 272_001, cached: 200_000, output: 1 }
      }
    ]).map((line) => parseCodexUsageRecord(line, context))

    expect(atThreshold).toMatchObject({
      longContextInputTokens: 0,
      longContextCachedInputTokens: 0,
      longContextOutputTokens: 0
    })
    expect(overThreshold).toMatchObject({
      longContextInputTokens: 272_001,
      longContextCachedInputTokens: 200_000,
      longContextOutputTokens: 1
    })
  })

  it('never classes a total-only delta as long, since it can span several requests', () => {
    const context = createContext()
    const events = [
      tokenCountLine('2026-04-09T10:00:00.000Z', { input: 100_000, cached: 50_000, output: 1_000 }),
      tokenCountLine('2026-04-09T10:01:00.000Z', {
        input: 400_000,
        cached: 200_000,
        output: 3_000
      }),
      tokenCountLine('2026-04-09T10:01:01.000Z', {
        input: 400_000,
        cached: 200_000,
        output: 3_000
      }),
      tokenCountLine('2026-04-09T10:02:00.000Z', { input: 500_000, cached: 250_000, output: 4_000 })
    ].map((line) => parseCodexUsageRecord(line, context))

    expect(events.map((event) => event?.inputTokens ?? null)).toEqual([
      100_000,
      300_000,
      null,
      100_000
    ])
    expect(events.map((event) => event?.longContextInputTokens ?? null)).toEqual([0, 0, null, 0])
    expect(events[1]).toMatchObject({
      longContextCachedInputTokens: 0,
      longContextOutputTokens: 0
    })
  })
})
