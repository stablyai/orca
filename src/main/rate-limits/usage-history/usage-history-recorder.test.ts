import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { UsageHistoryRecorder } from './usage-history-recorder'

// Fixed and ahead of the real clock, so the load-time prune keeps these windows.
const now = 4_000_000_000_000
const HOUR = 3_600_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function historyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usage-history-'))
  dirs.push(dir)
  return join(dir, 'history.json')
}

const limits = (
  usedPercent: number,
  updatedAt: number,
  accountId?: string
): ProviderRateLimits => ({
  provider: 'claude',
  session: null,
  weekly: { usedPercent, windowMinutes: 10080, resetsAt: now + 86_400_000, resetDescription: null },
  updatedAt,
  error: null,
  status: 'ok',
  ...(accountId
    ? { usageMetadata: { readingAccount: { accountId, runtime: 'host', wslDistro: null } } }
    : {})
})

const percents = (recorder: UsageHistoryRecorder): number[] | undefined =>
  recorder.snapshot(now)['claude:weekly']?.samples.map((sample) => sample.usedPercent)

describe('UsageHistoryRecorder', () => {
  it('keeps saved history across a restart, even when a reading lands before the file loads', async () => {
    const file = historyFile()
    const first = new UsageHistoryRecorder(file)
    await first.loaded
    first.record({ claude: limits(10, now - 3 * HOUR) }, now)
    first.record({ claude: limits(10, now - 3 * HOUR) }, now)
    first.record({ claude: { ...limits(12, now - 2 * HOUR), status: 'error' } }, now)
    first.record({ claude: limits(14, now - 2 * HOUR) }, now)
    await first.flush()

    const second = new UsageHistoryRecorder(file)
    // A restored last-good reading arrives while the saved history is still loading.
    second.record({ claude: limits(14, now - 2 * HOUR) }, now)
    second.record({ claude: limits(20, now - HOUR) }, now)
    await second.loaded
    expect(second.snapshot(now)['claude:weekly']?.samples).toEqual([
      { at: now - 3 * HOUR, usedPercent: 10 },
      { at: now - 2 * HOUR, usedPercent: 14 },
      { at: now - HOUR, usedPercent: 20 }
    ])
  })

  it('keeps each account its own history and shows the account read last', async () => {
    const file = historyFile()
    const first = new UsageHistoryRecorder(file)
    await first.loaded
    first.record({ claude: limits(10, now - 3 * HOUR, 'work') }, now)
    first.record({ claude: limits(70, now - 2 * HOUR, 'personal') }, now)
    expect(percents(first)).toEqual([70])
    first.record({ claude: limits(15, now - HOUR, 'work') }, now)
    expect(percents(first)).toEqual([10, 15])
    await first.flush()

    const second = new UsageHistoryRecorder(file)
    await second.loaded
    expect(percents(second)).toEqual([10, 15])
    second.record({ claude: limits(75, now - HOUR / 2, 'personal') }, now)
    expect(percents(second)).toEqual([70, 75])
  })

  it('starts fresh from a corrupt or truncated file and replaces it on the next save', async () => {
    const file = historyFile()
    writeFileSync(file, '{"version":2,"activeAccounts":{},"series":[{"provider":"cl')
    const recorder = new UsageHistoryRecorder(file)
    await recorder.loaded
    expect(recorder.snapshot(now)).toEqual({})
    recorder.record({ claude: limits(5, now - HOUR) }, now)
    await recorder.flush()

    const reloaded = new UsageHistoryRecorder(file)
    await reloaded.loaded
    expect(percents(reloaded)).toEqual([5])
  })

  it('carries a version 1 file over to the first account read', async () => {
    const file = historyFile()
    const series = { resetsAt: now + 86_400_000, windowMinutes: 10080 }
    writeFileSync(
      file,
      JSON.stringify({
        'claude:weekly': { ...series, samples: [{ at: now - HOUR, usedPercent: 9 }] }
      })
    )
    const recorder = new UsageHistoryRecorder(file)
    await recorder.loaded
    expect(percents(recorder)).toEqual([9])
    recorder.record({ claude: limits(11, now - HOUR / 2, 'work') }, now)
    expect(percents(recorder)).toEqual([9, 11])
  })
})
