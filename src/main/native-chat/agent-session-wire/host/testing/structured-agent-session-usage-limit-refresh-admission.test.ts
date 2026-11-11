import { afterEach, expect, it, vi } from 'vitest'
import { HOST_TEST_NOW as NOW } from './structured-agent-session-host-test-data'
import {
  FLEET_HOME,
  usageLimitFleet,
  weekly
} from './structured-agent-session-usage-limit-fleet.test-fixture'
import { RateLimitService } from '../../../../rate-limits/service/rate-limit-service'
import { fetchCodexRateLimits } from '../../../../rate-limits/providers/codex/codex-fetcher'

vi.mock('../../../../rate-limits/providers/codex/codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

afterEach(() => {
  vi.useRealTimers()
})

/** Lets a started provider fetch finish before the next sweep. */
async function settleFetches(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

it('asks one account for at most one reading per 10 minutes however many unknown-reset chats hold it, at N and 10N', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // The account's last reading is ten minutes old when the first chats are shown.
  const seededAt = NOW - 10 * 60_000
  for (const count of [300, 3000]) {
    vi.setSystemTime(seededAt)
    vi.mocked(fetchCodexRateLimits).mockReset()
    vi.mocked(fetchCodexRateLimits).mockImplementation(async () => weekly(100, null, Date.now()))
    const service = new RateLimitService()
    service.setCodexHomePathResolver(() => ({ kind: 'ready', codexHomePath: FLEET_HOME }))
    service.requestUsageReading('codex')
    await settleFetches()
    expect(vi.mocked(fetchCodexRateLimits)).toHaveBeenCalledTimes(1)
    let shown = 0
    const fleet = usageLimitFleet({
      count,
      provider: 'codex',
      now: seededAt,
      sources: { settings: {}, shellEnv: {}, shellRevision: 1, reading: null, limits: null },
      rateLimits: () => service,
      shown: () => shown
    })
    // Chats enter unknown-reset holds on every 10 s sweep across ten minutes; each read finishes
    // before the next sweep.
    for (let sweep = 0; sweep < 60; sweep += 1) {
      const at = NOW + sweep * 10_000
      vi.setSystemTime(at)
      shown = Math.ceil((count * (sweep + 1)) / 60)
      await fleet.pass(at)
      await settleFetches()
    }
    expect(fleet.state(`chat-${count - 1}`)).toMatchObject({ state: 'failed' })
    expect(vi.mocked(fetchCodexRateLimits)).toHaveBeenCalledTimes(2)
    service.stop()
  }
})
