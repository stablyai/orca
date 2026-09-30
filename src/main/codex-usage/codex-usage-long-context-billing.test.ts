import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStoreWithState, setupCodexUsageStoreEnv } from './store-test-harness'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanCodexUsageFilesViaWorker: vi.fn()
}))

import { createUsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import { parseCodexUsageFile } from './codex-rollout-file-parse'
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

/** Replays `requests` as last_token_usage records with a running total, like Codex writes them. */
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

describe('long-context cost across rollups', () => {
  setupCodexUsageStoreEnv(getPathMock)
  let rolloutDir: string | null = null

  afterEach(() => {
    if (rolloutDir) {
      rmSync(rolloutDir, { recursive: true, force: true })
      rolloutDir = null
    }
  })

  it('prices a mixed two-day rollout per request, and the summary matches the breakdown', async () => {
    rolloutDir = mkdtempSync(join(tmpdir(), 'orca-codex-long-context-'))
    const rolloutPath = join(rolloutDir, 'rollout-session-1.jsonl')
    const shortRequest: Usage = { input: 200_000, cached: 100_000, output: 10_000 }
    const requests = [
      {
        timestamp: '2026-04-08T12:00:00.000Z',
        usage: { input: 300_000, cached: 150_000, output: 100_000 }
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        timestamp: `2026-04-0${index < 5 ? 8 : 9}T12:${String(10 + index).padStart(2, '0')}:00.000Z`,
        usage: shortRequest
      }))
    ]
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-1', cwd: '/workspace/repo' }
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { cwd: '/workspace/repo', model: 'gpt-6-astra' }
      }),
      ...requestLines(requests)
    ]
    writeFileSync(rolloutPath, `${lines.join('\n')}\n`)

    const parsed = await parseCodexUsageFile(rolloutPath, await createUsageWorktreeResolver([]))
    const store = createStoreWithState({
      sessions: parsed.sessions,
      dailyAggregates: parsed.dailyAggregates
    })

    expect(parsed.dailyAggregates).toHaveLength(2)
    expect(parsed.sessions[0]?.locationModelBreakdown[0]).toMatchObject({
      longContextInputTokens: 300_000,
      longContextCachedInputTokens: 150_000,
      longContextOutputTokens: 100_000
    })
    const summary = await store.getSummary('all', '30d')
    const breakdown = await store.getBreakdown('all', '30d', 'model')
    // Long request: 0.15M*$20 + 0.15M*$2 + 0.1M*$75 = 10.8.
    // Ten short requests: 10 * (0.1M*$10 + 0.1M*$1 + 0.01M*$50) = 16.
    expect(summary.estimatedCostUsd).toBeCloseTo(26.8, 9)
    expect(breakdown).toHaveLength(1)
    expect(breakdown[0]?.estimatedCostUsd).toBeCloseTo(26.8, 9)

    store['state'].scanState.enabled = true
    vi.spyOn(store, 'refresh').mockResolvedValue({ ...store.getScanState(), lastScanError: null })
    const runUsage = await store.getAutomationRunUsage({
      worktreeId: 'unrelated-worktree',
      terminalSessionId: 'session-1',
      startedAt: Date.parse('2026-04-08T11:59:00.000Z'),
      completedAt: Date.parse('2026-04-09T12:30:00.000Z')
    })
    expect(runUsage.estimatedCostUsd).toBeCloseTo(26.8, 9)
  })
})
