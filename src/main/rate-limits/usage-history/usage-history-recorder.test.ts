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
})
