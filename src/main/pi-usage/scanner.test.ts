import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanPiUsageFiles } from './scanner'

const CWD = '/work/pi-project'
const FIRST_RESPONSE_AT = Date.parse('2026-11-09T10:00:00.000Z')
const SECOND_RESPONSE_AT = Date.parse('2026-11-09T10:05:00.000Z')
const FORK_RESPONSE_AT = Date.parse('2026-11-09T11:00:00.000Z')

function header(id: string): Record<string, unknown> {
  return { type: 'session', version: 3, id, timestamp: '2026-11-09T09:59:00.000Z', cwd: CWD }
}

function assistant(
  timestamp: number,
  responseId: string,
  usage: Record<string, number>,
  costTotal = 0
): Record<string, unknown> {
  return {
    type: 'message',
    id: responseId.slice(-8),
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      usage: { cacheRead: 0, cacheWrite: 0, reasoning: 0, ...usage, cost: { total: costTotal } },
      stopReason: 'stop',
      timestamp,
      responseId
    }
  }
}

function writeLog(dir: string, name: string, records: Record<string, unknown>[]): void {
  writeFileSync(join(dir, name), `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
}

describe('scanPiUsageFiles', () => {
  let sessionsDir: string

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'orca-pi-usage-'))
  })

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
  })

  it('counts cache-inclusive input and cost once across forks and skips OMP logs', async () => {
    const bucket = join(sessionsDir, '--work-pi-project--')
    mkdirSync(bucket)
    const first = assistant(
      FIRST_RESPONSE_AT,
      'resp-first',
      { input: 100, output: 40, cacheRead: 900, cacheWrite: 50, reasoning: 10 },
      0.012
    )
    // Unpriced models record a zero cost.
    const second = assistant(SECOND_RESPONSE_AT, 'resp-second', { input: 20, output: 5 })
    writeLog(bucket, '2026-11-09T09-59-00-000Z_parent.jsonl', [header('parent'), first, second])
    // A fork copies the parent's entries before its own responses.
    writeLog(bucket, '2026-11-09T10-30-00-000Z_fork.jsonl', [
      header('fork'),
      first,
      second,
      assistant(FORK_RESPONSE_AT, 'resp-fork', { input: 7, output: 3 }, 0.003)
    ])
    writeLog(bucket, '2026-11-09T12-00-00-000Z_omp.jsonl', [
      header('omp'),
      { type: 'title', v: 1, title: 'OMP session' },
      assistant(FORK_RESPONSE_AT + 1000, 'resp-omp', { input: 5000, output: 5000 }, 9)
    ])

    const result = await scanPiUsageFiles([], [], undefined, sessionsDir)

    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual(['fork', 'parent'])
    const totals = result.dailyAggregates.reduce(
      (sum, row) => ({
        input: sum.input + row.inputTokens,
        cached: sum.cached + row.cachedInputTokens,
        output: sum.output + row.outputTokens,
        reasoning: sum.reasoning + row.reasoningOutputTokens,
        events: sum.events + row.eventCount,
        cost: sum.cost + (row.estimatedCostUsd ?? 0)
      }),
      { input: 0, cached: 0, output: 0, reasoning: 0, events: 0, cost: 0 }
    )
    expect({ ...totals, cost: Number(totals.cost.toFixed(6)) }).toEqual({
      input: 1077,
      cached: 900,
      output: 48,
      reasoning: 10,
      events: 3,
      cost: 0.015
    })
    expect(new Set(result.dailyAggregates.map((row) => row.model))).toEqual(
      new Set(['anthropic/claude-sonnet-5-5'])
    )
  })
})
