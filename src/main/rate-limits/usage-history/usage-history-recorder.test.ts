import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { UsageHistoryRecorder } from './usage-history-recorder'

// Fixed and ahead of the real clock, so the load-time prune keeps these windows.
const now = 4_000_000_000_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const limits = (usedPercent: number, updatedAt: number): ProviderRateLimits => ({
  provider: 'claude',
  session: null,
  weekly: {
    usedPercent,
    windowMinutes: 10080,
    resetsAt: updatedAt + 86_400_000,
    resetDescription: null
  },
  updatedAt,
  error: null,
  status: 'ok'
})

describe('UsageHistoryRecorder', () => {
  it('persists samples across restarts and skips repeated readings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-history-'))
    dirs.push(dir)
    const file = join(dir, 'history.json')
    const first = new UsageHistoryRecorder(file)
    await first.loaded
    first.record({ claude: limits(10, now - 7_200_000) }, now)
    first.record({ claude: limits(10, now - 7_200_000) }, now)
    first.record({ claude: { ...limits(12, now - 3_600_000), status: 'error' } }, now)
    first.record({ claude: limits(14, now - 3_600_000) }, now)
    await first.flush()

    const second = new UsageHistoryRecorder(file)
    await second.loaded
    expect(second.snapshot(now)['claude:weekly']?.samples).toEqual([
      { at: now - 7_200_000, usedPercent: 10 },
      { at: now - 3_600_000, usedPercent: 14 }
    ])
  })

  it('starts a new series when the same window is read for a different account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-history-'))
    dirs.push(dir)
    const recorder = new UsageHistoryRecorder(join(dir, 'history.json'))
    await recorder.loaded
    const account = (id: string, usedPercent: number, updatedAt: number): ProviderRateLimits => ({
      ...limits(usedPercent, updatedAt),
      usageMetadata: { readingAccount: { accountId: id, runtime: 'host', wslDistro: null } }
    })
    recorder.record({ claude: account('a', 80, now - 7_200_000) }, now)
    recorder.record({ claude: account('b', 10, now - 3_600_000) }, now)
    expect(recorder.snapshot(now)['claude:weekly']?.samples).toEqual([
      { at: now - 3_600_000, usedPercent: 10 }
    ])
    recorder.record({ claude: account('b', 12, now - 1_800_000) }, now)
    expect(recorder.snapshot(now)['claude:weekly']?.samples).toEqual([
      { at: now - 3_600_000, usedPercent: 10 },
      { at: now - 1_800_000, usedPercent: 12 }
    ])
  })

  it('keeps saved samples when a reading is flushed before the file loads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-history-'))
    dirs.push(dir)
    const file = join(dir, 'history.json')
    const first = new UsageHistoryRecorder(file)
    await first.loaded
    first.record({ claude: limits(10, now - 7_200_000) }, now)
    await first.flush()

    const early = new UsageHistoryRecorder(file)
    early.record({ claude: limits(20, now - 3_600_000) }, now)
    await early.flush()

    const reopened = new UsageHistoryRecorder(file)
    await reopened.loaded
    expect(reopened.snapshot(now)['claude:weekly']?.samples).toEqual([
      { at: now - 7_200_000, usedPercent: 10 },
      { at: now - 3_600_000, usedPercent: 20 }
    ])
  })
})
